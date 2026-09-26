import type { TimeOffRequest, TimeOffStatus } from '@shared/types';
import { diffDays, todayIn } from '@shared/time';
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
import { getSettings, zoneFor } from './settings';

const REQUEST_SQL = `
  SELECT r.id, r.user_id AS "userId", u.name AS "userName", u.tier_id AS "tierId",
         json_build_object('id', tt.id, 'name', tt.name, 'color', tt.color, 'paid', tt.paid) AS type,
         r.start_date AS "startDate", r.end_date AS "endDate", r.note, r.status,
         r.reviewed_at AS "reviewedAt", rb.name AS "reviewedByName", r.review_note AS "reviewNote",
         r.created_at AS "createdAt",
         -- Time-off days are the organization's calendar days, as in the builder.
         (SELECT count(*)::int FROM shifts s
           WHERE s.user_id = r.user_id AND s.deleted_at IS NULL
             AND s.start_time < ((r.end_date + 1)::timestamp AT TIME ZONE os.timezone)
             AND s.end_time > (r.start_date::timestamp AT TIME ZONE os.timezone)
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
  startDate: string,
  endDate: string,
  excludeId: string | null = null,
): Promise<void> {
  const { rows } = await db.query(
    `SELECT 1 FROM time_off_requests
      WHERE user_id = $1 AND status IN ('pending', 'approved') AND id IS DISTINCT FROM $4
        AND start_date <= $3 AND end_date >= $2
      LIMIT 1`,
    [userId, startDate, endDate, excludeId],
  );
  if (rows.length) {
    throw conflict(
      'There is already time off requested for some of these days',
      'TIME_OFF_OVERLAP',
    );
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
  startDate: string;
  endDate: string;
  note: string | null;
}

function validateDates(input: TimeOffInput): void {
  if (input.endDate < input.startDate) {
    throw badRequest('The last day must be on or after the first day', {
      endDate: 'Before start date',
    });
  }
  if (diffDays(input.startDate, input.endDate) >= 366) {
    throw badRequest('Time off can be requested for up to one year at a time', {
      endDate: 'Too long',
    });
  }
}

/** A team member asks for time off; admins are emailed. */
export async function requestTimeOff(
  db: Db,
  config: Config,
  user: AuthUser,
  input: TimeOffInput,
): Promise<TimeOffRequest> {
  validateDates(input);
  const id = await withTransaction(db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`time-off:${user.id}`]);
    await assertActiveType(client, input.typeId);
    await assertNoOverlap(client, user.id, input.startDate, input.endDate);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO time_off_requests (user_id, type_id, start_date, end_date, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $1) RETURNING id`,
      [user.id, input.typeId, input.startDate, input.endDate, input.note],
    );
    const requestId = rows[0]!.id;
    const request = await getTimeOffRequest(client, requestId);
    await notifyAdmins(
      client,
      config,
      user.id,
      (ctx, admin) =>
        timeOffRequestedTemplate(ctx, {
          recipientName: admin.name,
          requesterName: user.name,
          typeName: request.type.name,
          startDate: request.startDate,
          endDate: request.endDate,
          note: request.note,
          conflicts: request.conflicts ?? 0,
        }),
      'time_off_requested',
    );
    await audit(
      client,
      user.id,
      'time_off.requested',
      { type: 'time_off', id: requestId },
      {
        typeName: request.type.name,
        startDate: request.startDate,
        endDate: request.endDate,
      },
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
  validateDates(input);
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
    await assertActiveType(client, input.typeId);
    await assertNoOverlap(client, userId, input.startDate, input.endDate);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO time_off_requests
         (user_id, type_id, start_date, end_date, note, status, reviewed_by, reviewed_at, created_by)
       VALUES ($1, $2, $3, $4, $5, 'approved', $6, now(), $6) RETURNING id`,
      [userId, input.typeId, input.startDate, input.endDate, input.note, admin.id],
    );
    const requestId = rows[0]!.id;
    const request = await getTimeOffRequest(client, requestId);
    if (person.id !== admin.id) {
      const settings = await getSettings(client);
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
            startDate: request.startDate,
            endDate: request.endDate,
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
      {
        personName: person.name,
        typeName: request.type.name,
        startDate: request.startDate,
        endDate: request.endDate,
      },
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
      await assertNoOverlap(client, current.userId, r.startDate, r.endDate, requestId);
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
      const settings = await getSettings(client);
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
            startDate: request.startDate,
            endDate: request.endDate,
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
      {
        personName: request.userName,
        typeName: request.type.name,
        startDate: request.startDate,
        endDate: request.endDate,
      },
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
    const { rows } = await client.query<{ status: TimeOffStatus; userId: string; endDate: string }>(
      `SELECT status, user_id AS "userId", end_date AS "endDate"
         FROM time_off_requests WHERE id = $1 FOR UPDATE`,
      [requestId],
    );
    const current = rows[0];
    if (!current || current.userId !== user.id) throw notFound('Time-off request');
    const settings = await getSettings(client);
    if (current.status === 'approved' && current.endDate < todayIn(zoneFor(user, settings))) {
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
      await notifyAdmins(
        client,
        config,
        user.id,
        (ctx, admin) =>
          timeOffCancelledTemplate(ctx, {
            recipientName: admin.name,
            requesterName: user.name,
            typeName: request.type.name,
            startDate: request.startDate,
            endDate: request.endDate,
          }),
        'time_off_cancelled',
      );
    }
    await audit(
      client,
      user.id,
      'time_off.cancelled',
      { type: 'time_off', id: requestId },
      {
        typeName: request.type.name,
        startDate: request.startDate,
        endDate: request.endDate,
        wasApproved: current.status === 'approved',
      },
    );
  });
  return getTimeOffRequest(db, requestId);
}

async function notifyAdmins(
  client: Queryable,
  config: Config,
  exceptUserId: string,
  render: (
    ctx: { orgName: string; appUrl: string },
    admin: { name: string },
  ) => { subject: string; html: string; text: string },
  kind: 'time_off_requested' | 'time_off_cancelled',
): Promise<void> {
  const settings = await getSettings(client);
  const ctx = { orgName: settings.orgName, appUrl: config.appUrl };
  const { rows: admins } = await client.query<{ id: string; name: string; email: string }>(
    `SELECT id, name, email FROM users
      WHERE role = 'admin' AND deactivated_at IS NULL AND email_verified_at IS NOT NULL AND id <> $1`,
    [exceptUserId],
  );
  for (const admin of admins) {
    await enqueueEmail(client, {
      userId: admin.id,
      to: admin.email,
      kind,
      email: render(ctx, admin),
    });
  }
}
