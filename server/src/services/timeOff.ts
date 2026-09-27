import type { TimeOffRequest, TimeOffStatus } from '@shared/types';
import { diffDays, localDate, todayIn } from '@shared/time';
import { isPartialDay, timeOffBounds, type TimeOffSpan } from '@shared/timeOff';
import type { AuthUser } from '../auth/types';
import type { Config } from '../config';
import { withTransaction, type Db, type Queryable } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { enqueueEmail } from '../email/outbox';
import {
  timeOffCancelledTemplate,
  timeOffRequestedTemplate,
  timeOffReviewedTemplate,
} from '../email/templates';
import { audit } from './audit';
import { notifyAdmins } from './notify';
import { getSettings, timeFormatFor, zoneFor } from './settings';

/**
 * When a request (`r`, with org_settings as `os`) covers, as a tstzrange: its
 * hours for part of a day, else whole days of the organization's calendar
 * (as in the builder).
 */
export const TIME_OFF_SPAN = `
  CASE WHEN r.start_time IS NULL
       THEN tstzrange((r.start_date::timestamp AT TIME ZONE os.timezone),
                      ((r.end_date + 1)::timestamp AT TIME ZONE os.timezone))
       ELSE tstzrange(r.start_time, r.end_time) END`;

const REQUEST_SQL = `
  SELECT r.id, r.user_id AS "userId", u.name AS "userName", u.tier_id AS "tierId",
         json_build_object('id', tt.id, 'name', tt.name, 'color', tt.color, 'paid', tt.paid) AS type,
         r.start_date AS "startDate", r.end_date AS "endDate",
         r.start_time AS "startTime", r.end_time AS "endTime", r.note, r.status,
         r.reviewed_at AS "reviewedAt", rb.name AS "reviewedByName", r.review_note AS "reviewNote",
         r.created_at AS "createdAt",
         (SELECT count(*)::int FROM shifts s
           WHERE s.user_id = r.user_id AND s.deleted_at IS NULL
             AND tstzrange(s.start_time, s.end_time) && ${TIME_OFF_SPAN}
         ) AS conflicts
    FROM time_off_requests r
    JOIN users u ON u.id = r.user_id
    JOIN time_off_types tt ON tt.id = r.type_id
    LEFT JOIN users rb ON rb.id = r.reviewed_by
    CROSS JOIN org_settings os`;

/**
 * The conflict count includes draft and unpublished shifts, which only admins
 * may know about; strip it from anything a team member sees.
 */
export function forMember(request: TimeOffRequest): TimeOffRequest {
  const { conflicts: _hidden, ...visible } = request;
  return visible;
}

export async function getTimeOffRequest(db: Queryable, id: string): Promise<TimeOffRequest> {
  const { rows } = await db.query<TimeOffRequest>(`${REQUEST_SQL} WHERE r.id = $1`, [id]);
  if (!rows[0]) throw notFound('Time-off request');
  return rows[0];
}

export async function listTimeOff(
  db: Queryable,
  filters: { userId?: string; status?: TimeOffStatus | 'all'; from?: string; to?: string },
): Promise<TimeOffRequest[]> {
  const status = filters.status && filters.status !== 'all' ? filters.status : null;
  const { rows } = await db.query<TimeOffRequest>(
    `${REQUEST_SQL}
      WHERE ($1::uuid IS NULL OR r.user_id = $1)
        AND ($2::text IS NULL OR r.status = $2)
        AND ($3::date IS NULL OR r.end_date >= $3)
        AND ($4::date IS NULL OR r.start_date <= $4)
      ORDER BY r.start_date DESC, r.created_at DESC
      LIMIT 500`,
    [filters.userId ?? null, status, filters.from ?? null, filters.to ?? null],
  );
  return rows;
}

async function assertNoOverlap(
  db: Queryable,
  userId: string,
  bounds: { from: string; to: string },
  excludeId: string | null = null,
): Promise<void> {
  const { rows } = await db.query(
    `SELECT 1 FROM time_off_requests r CROSS JOIN org_settings os
      WHERE r.user_id = $1 AND r.status IN ('pending', 'approved') AND r.id IS DISTINCT FROM $4
        AND ${TIME_OFF_SPAN} && tstzrange($2, $3)
      LIMIT 1`,
    [userId, bounds.from, bounds.to, excludeId],
  );
  if (rows.length) {
    throw conflict('There is already time off requested during this time', 'TIME_OFF_OVERLAP');
  }
}

async function assertActiveType(db: Queryable, typeId: string): Promise<void> {
  const { rows } = await db.query<{ archived: boolean }>(
    'SELECT (archived_at IS NOT NULL) AS archived FROM time_off_types WHERE id = $1',
    [typeId],
  );
  if (!rows[0]) throw notFound('Time-off type');
  if (rows[0].archived)
    throw badRequest('That time-off type is no longer available', { typeId: 'Archived' });
}

export interface TimeOffInput {
  typeId: string;
  note: string | null;
  /** Whole days (the first and last)… */
  startDate?: string;
  endDate?: string;
  /** …or the exact hours of part of a day. */
  startTime?: string;
  endTime?: string;
}

const MAX_PARTIAL_HOURS = 24;

/** Check the days or hours asked for, and find the calendar days they fall on. */
function resolveSpan(input: TimeOffInput, tz: string): TimeOffSpan {
  if (input.startTime !== undefined || input.endTime !== undefined) {
    if (input.startDate !== undefined || input.endDate !== undefined) {
      throw badRequest('Give either whole days or a start and end time, not both');
    }
    if (!input.startTime || !input.endTime) {
      throw badRequest('Give both a start and an end time', {
        [input.startTime ? 'endTime' : 'startTime']: 'Required',
      });
    }
    const start = Date.parse(input.startTime);
    const end = Date.parse(input.endTime);
    if (end <= start) throw badRequest('The end must be after the start', { endTime: 'Too early' });
    if (end - start > MAX_PARTIAL_HOURS * 3_600_000) {
      throw badRequest('Part of a day can be up to 24 hours. For longer, choose whole days.', {
        endTime: 'Too long',
      });
    }
    const startTime = new Date(start).toISOString();
    const endTime = new Date(end).toISOString();
    return {
      startDate: localDate(startTime, tz),
      // Its last moment's day: time off that ends at midnight stays on one day.
      endDate: localDate(new Date(end - 1).toISOString(), tz),
      startTime,
      endTime,
    };
  }
  const { startDate, endDate } = input;
  if (!startDate || !endDate) {
    throw badRequest('Choose the first and last day', {
      [startDate ? 'endDate' : 'startDate']: 'Required',
    });
  }
  if (endDate < startDate) {
    throw badRequest('The last day must be on or after the first day', {
      endDate: 'Before start date',
    });
  }
  if (diffDays(startDate, endDate) >= 366) {
    throw badRequest('Time off can be requested for up to one year at a time', {
      endDate: 'Too long',
    });
  }
  return { startDate, endDate, startTime: null, endTime: null };
}

/** The when of a request, for audit entries: hours only for part of a day. */
function spanDetails(span: TimeOffSpan) {
  return {
    startDate: span.startDate,
    endDate: span.endDate,
    ...(isPartialDay(span) ? { startTime: span.startTime, endTime: span.endTime } : {}),
  };
}

const INSERT_SQL = `
  INSERT INTO time_off_requests
    (user_id, type_id, start_date, end_date, start_time, end_time, note, status, reviewed_by,
     reviewed_at, created_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $9::uuid IS NULL THEN NULL ELSE now() END, $10)
  RETURNING id`;

/** Someone's time zone and 12/24-hour choice, for emailing them. */
async function readerPrefs(db: Queryable, userId: string) {
  const settings = await getSettings(db);
  const { rows } = await db.query<{ timezone: string | null; timeFormat: '12h' | '24h' | null }>(
    'SELECT timezone, time_format AS "timeFormat" FROM users WHERE id = $1',
    [userId],
  );
  const user = rows[0] ?? { timezone: null, timeFormat: null };
  return { settings, tz: zoneFor(user, settings), timeFormat: timeFormatFor(user, settings) };
}

/** A team member asks for time off; admins are emailed. */
export async function requestTimeOff(
  db: Db,
  config: Config,
  user: AuthUser,
  input: TimeOffInput,
): Promise<TimeOffRequest> {
  const id = await withTransaction(db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`time-off:${user.id}`]);
    const { timezone } = await getSettings(client);
    const span = resolveSpan(input, timezone);
    await assertActiveType(client, input.typeId);
    await assertNoOverlap(client, user.id, timeOffBounds(span, timezone));
    const { rows } = await client.query<{ id: string }>(INSERT_SQL, [
      user.id,
      input.typeId,
      span.startDate,
      span.endDate,
      span.startTime,
      span.endTime,
      input.note,
      'pending',
      null,
      user.id,
    ]);
    const requestId = rows[0]!.id;
    const request = await getTimeOffRequest(client, requestId);
    await notifyAdmins(client, config, {
      topic: 'time_off',
      exceptUserId: user.id,
      kind: 'time_off_requested',
      render: (ctx, admin) =>
        timeOffRequestedTemplate(ctx, {
          recipientName: admin.name,
          requesterName: user.name,
          typeName: request.type.name,
          span: request,
          tz: admin.tz,
          timeFormat: admin.timeFormat,
          note: request.note,
          conflicts: request.conflicts ?? 0,
        }),
    });
    await audit(
      client,
      user.id,
      'time_off.requested',
      { type: 'time_off', id: requestId },
      { typeName: request.type.name, ...spanDetails(request) },
    );
    return requestId;
  });
  return getTimeOffRequest(db, id);
}

/** An admin records time off for someone; it's approved immediately. */
export async function addTimeOffForPerson(
  db: Db,
  config: Config,
  admin: AuthUser,
  userId: string,
  input: TimeOffInput,
): Promise<TimeOffRequest> {
  const id = await withTransaction(db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`time-off:${userId}`]);
    const { rows: users } = await client.query<{
      id: string;
      name: string;
      email: string;
      timezone: string | null;
      active: boolean;
    }>(
      'SELECT id, name, email, timezone, (deactivated_at IS NULL) AS active FROM users WHERE id = $1',
      [userId],
    );
    const person = users[0];
    if (!person) throw notFound('Person');
    if (!person.active) throw badRequest(`${person.name} is deactivated`);
    const { timezone } = await getSettings(client);
    const span = resolveSpan(input, timezone);
    await assertActiveType(client, input.typeId);
    await assertNoOverlap(client, userId, timeOffBounds(span, timezone));
    const { rows } = await client.query<{ id: string }>(INSERT_SQL, [
      userId,
      input.typeId,
      span.startDate,
      span.endDate,
      span.startTime,
      span.endTime,
      input.note,
      'approved',
      admin.id,
      admin.id,
    ]);
    const requestId = rows[0]!.id;
    const request = await getTimeOffRequest(client, requestId);
    if (person.id !== admin.id) {
      const { settings, tz, timeFormat } = await readerPrefs(client, person.id);
      await enqueueEmail(client, {
        userId: person.id,
        to: person.email,
        kind: 'time_off_reviewed',
        email: timeOffReviewedTemplate(
          { orgName: settings.orgName, appUrl: config.appUrl },
          {
            recipientName: person.name,
            status: 'approved',
            typeName: request.type.name,
            span: request,
            tz,
            timeFormat,
            reviewerName: admin.name,
            reviewNote: request.note,
            addedByAdmin: true,
          },
        ),
      });
    }
    await audit(
      client,
      admin.id,
      'time_off.added',
      { type: 'time_off', id: requestId },
      { personName: person.name, typeName: request.type.name, ...spanDetails(request) },
    );
    return requestId;
  });
  return getTimeOffRequest(db, id);
}

/** Approve or decline. Admins can also change their mind later. */
export async function reviewTimeOff(
  db: Db,
  config: Config,
  admin: AuthUser,
  requestId: string,
  decision: 'approved' | 'denied',
  note: string | null,
): Promise<TimeOffRequest> {
  await withTransaction(db, async (client) => {
    const { rows } = await client.query<{ status: TimeOffStatus; userId: string }>(
      'SELECT status, user_id AS "userId" FROM time_off_requests WHERE id = $1 FOR UPDATE',
      [requestId],
    );
    const current = rows[0];
    if (!current) throw notFound('Time-off request');
    // Same per-person lock as new requests, so re-approving can't race one.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `time-off:${current.userId}`,
    ]);
    const allowedFrom: TimeOffStatus[] =
      decision === 'approved' ? ['pending', 'denied'] : ['pending', 'approved'];
    if (!allowedFrom.includes(current.status)) {
      throw conflict(`This request is already ${current.status}`, 'INVALID_STATUS');
    }
    if (decision === 'approved' && current.status === 'denied') {
      const r = await getTimeOffRequest(client, requestId);
      const { timezone } = await getSettings(client);
      await assertNoOverlap(client, current.userId, timeOffBounds(r, timezone), requestId);
    }
    await client.query(
      `UPDATE time_off_requests
          SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4
        WHERE id = $1`,
      [requestId, decision, admin.id, note],
    );
    const request = await getTimeOffRequest(client, requestId);
    const { rows: people } = await client.query<{ id: string; name: string; email: string }>(
      'SELECT id, name, email FROM users WHERE id = $1 AND deactivated_at IS NULL',
      [request.userId],
    );
    const person = people[0];
    if (person && person.id !== admin.id) {
      const { settings, tz, timeFormat } = await readerPrefs(client, person.id);
      await enqueueEmail(client, {
        userId: person.id,
        to: person.email,
        kind: 'time_off_reviewed',
        email: timeOffReviewedTemplate(
          { orgName: settings.orgName, appUrl: config.appUrl },
          {
            recipientName: person.name,
            status: decision,
            typeName: request.type.name,
            span: request,
            tz,
            timeFormat,
            reviewerName: admin.name,
            reviewNote: note,
          },
        ),
      });
    }
    await audit(
      client,
      admin.id,
      `time_off.${decision}`,
      { type: 'time_off', id: requestId },
      { personName: request.userName, typeName: request.type.name, ...spanDetails(request) },
    );
  });
  return getTimeOffRequest(db, requestId);
}

/** A team member withdraws a pending request or cancels upcoming approved time off. */
export async function cancelTimeOff(
  db: Db,
  config: Config,
  user: AuthUser,
  requestId: string,
): Promise<TimeOffRequest> {
  await withTransaction(db, async (client) => {
    const { rows } = await client.query<{
      status: TimeOffStatus;
      userId: string;
      endDate: string;
      endTime: string | null;
    }>(
      `SELECT status, user_id AS "userId", end_date AS "endDate", end_time AS "endTime"
         FROM time_off_requests WHERE id = $1 FOR UPDATE`,
      [requestId],
    );
    const current = rows[0];
    if (!current || current.userId !== user.id) throw notFound('Time-off request');
    const settings = await getSettings(client);
    const over = current.endTime
      ? Date.parse(current.endTime) <= Date.now()
      : current.endDate < todayIn(zoneFor(user, settings));
    if (current.status === 'approved' && over) {
      throw forbidden("Time off that's already over can't be cancelled", 'TIME_OFF_PAST');
    }
    if (current.status !== 'pending' && current.status !== 'approved') {
      throw conflict(`This request is already ${current.status}`, 'INVALID_STATUS');
    }
    await client.query("UPDATE time_off_requests SET status = 'cancelled' WHERE id = $1", [
      requestId,
    ]);
    const request = await getTimeOffRequest(client, requestId);
    if (current.status === 'approved') {
      await notifyAdmins(client, config, {
        topic: 'time_off',
        exceptUserId: user.id,
        kind: 'time_off_cancelled',
        render: (ctx, admin) =>
          timeOffCancelledTemplate(ctx, {
            recipientName: admin.name,
            requesterName: user.name,
            typeName: request.type.name,
            span: request,
            tz: admin.tz,
            timeFormat: admin.timeFormat,
          }),
      });
    }
    await audit(
      client,
      user.id,
      'time_off.cancelled',
      { type: 'time_off', id: requestId },
      {
        typeName: request.type.name,
        ...spanDetails(request),
        wasApproved: current.status === 'approved',
      },
    );
  });
  return getTimeOffRequest(db, requestId);
}
