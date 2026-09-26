import type { OpenShift, OpenShiftStatus } from '@shared/types';
import type { AuthUser } from '../auth/types';
import type { Config } from '../config';
import { withTransaction, type Db, type Queryable } from '../db';
import {
  openShiftCancelledTemplate,
  openShiftClaimedTemplate,
  openShiftPostedTemplate,
  openShiftReviewedTemplate,
  type EmailShift,
} from '../email/templates';
import { badRequest, conflict, notFound } from '../errors';
import { audit } from './audit';
import { busyBetween, busyReason } from './availability';
import { notifyAdmins, notifyPerson, type Reader } from './notify';
import { lockSchedule } from './schedules';

const MAX_HOURS = 24;

const OPEN_SHIFT_SQL = `
  SELECT o.id, o.status, o.schedule_id AS "scheduleId", sc.name AS "scheduleName",
         json_build_object('id', t.id, 'name', t.name, 'color', t.color) AS tier,
         CASE WHEN l.id IS NULL THEN NULL
              ELSE json_build_object('id', l.id, 'name', l.name, 'color', l.color) END AS label,
         o.start_time AS "startTime", o.end_time AS "endTime", o.notes,
         CASE WHEN cu.id IS NULL THEN NULL
              ELSE json_build_object('id', cu.id, 'name', cu.name) END AS "claimedBy",
         o.claimed_at AS "claimedAt", rb.name AS "reviewedByName", o.created_at AS "createdAt"
    FROM open_shifts o
    JOIN schedules sc ON sc.id = o.schedule_id
    JOIN tiers t ON t.id = o.tier_id
    LEFT JOIN labels l ON l.id = o.label_id
    LEFT JOIN users cu ON cu.id = o.claimed_by
    LEFT JOIN users rb ON rb.id = o.reviewed_by`;

/** Open shifts that started before anyone got them can't be picked up any more. */
async function expireStarted(db: Queryable): Promise<void> {
  await db.query(
    `UPDATE open_shifts SET status = 'expired'
      WHERE status IN ('open', 'claimed') AND start_time <= now()`,
  );
}

export async function getOpenShift(db: Queryable, id: string): Promise<OpenShift> {
  const { rows } = await db.query<OpenShift>(`${OPEN_SHIFT_SQL} WHERE o.id = $1`, [id]);
  if (!rows[0]) throw notFound('Open shift');
  return rows[0];
}

/** For admins: picked up (to approve) first, then open, then the last month's others. */
export async function listOpenShifts(db: Queryable): Promise<OpenShift[]> {
  await expireStarted(db);
  const { rows } = await db.query<OpenShift>(
    `${OPEN_SHIFT_SQL}
      WHERE o.status IN ('open', 'claimed') OR o.updated_at > now() - interval '30 days'
      ORDER BY (o.status = 'claimed') DESC, (o.status = 'open') DESC, o.start_time
      LIMIT 200`,
  );
  return rows;
}

/** What someone can pick up in their tier, and what they've picked up that's waiting. */
export async function openShiftsFor(db: Queryable, user: AuthUser): Promise<OpenShift[]> {
  await expireStarted(db);
  if (!user.tierId) return [];
  const { rows } = await db.query<OpenShift>(
    `${OPEN_SHIFT_SQL}
      WHERE o.tier_id = $1 AND o.start_time > now()
        AND ((o.status = 'open' AND NOT ($2 = ANY(o.declined_ids)))
             OR (o.status = 'claimed' AND o.claimed_by = $2))
      ORDER BY o.start_time`,
    [user.tierId, user.id],
  );
  if (!rows.length) return [];
  const busy = await busyBetween(
    db,
    [user.id],
    rows[0]!.startTime,
    new Date(Math.max(...rows.map((o) => Date.parse(o.endTime)))).toISOString(),
  );
  return rows.map((o) => ({
    ...o,
    busy: o.status === 'open' ? busyReason(busy, user.id, o.startTime, o.endTime) : null,
  }));
}

const emailShift = (o: OpenShift): EmailShift => ({
  id: o.id,
  startTime: o.startTime,
  endTime: o.endTime,
  labelName: o.label?.name ?? null,
  color: o.label?.color ?? o.tier.color,
  notes: o.notes,
  needsConfirmation: false,
});

async function reader(db: Queryable, userId: string): Promise<Reader & { name: string }> {
  const { rows } = await db.query<Reader & { name: string }>(
    `SELECT id, name, email, (deactivated_at IS NULL) AS active, timezone,
            time_format AS "timeFormat"
       FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0]!;
}

/** Post a shift for everyone in a tier to pick up; they're emailed right away. */
export async function postOpenShift(
  db: Db,
  config: Config,
  admin: AuthUser,
  input: {
    scheduleId: string | null;
    tierId: string;
    labelId: string | null;
    startTime: string;
    endTime: string;
    notes: string | null;
  },
): Promise<OpenShift> {
  const start = Date.parse(input.startTime);
  const end = Date.parse(input.endTime);
  if (!(end > start)) throw badRequest('It must end after it starts', { endTime: 'Too early' });
  if (end - start > MAX_HOURS * 3_600_000) {
    throw badRequest('An open shift can be up to 24 hours long', { endTime: 'Too long' });
  }
  if (start <= Date.now()) throw badRequest('Pick a time that hasn’t started yet');
  const id = await withTransaction(db, async (client) => {
    const { rows: tiers } = await client.query<{ name: string }>(
      'SELECT name FROM tiers WHERE id = $1',
      [input.tierId],
    );
    if (!tiers[0]) throw notFound('Tier');
    if (input.labelId) {
      const { rows: labels } = await client.query<{ tierId: string | null }>(
        'SELECT tier_id AS "tierId" FROM labels WHERE id = $1',
        [input.labelId],
      );
      if (!labels[0]) throw notFound('Label');
      if (labels[0].tierId && labels[0].tierId !== input.tierId) {
        throw badRequest(`That label isn't for ${tiers[0].name}`, { labelId: 'Wrong tier' });
      }
    }
    const { rows: schedules } = await client.query<{ id: string }>(
      input.scheduleId
        ? 'SELECT id FROM schedules WHERE id = $1'
        : 'SELECT id FROM schedules WHERE is_default',
      input.scheduleId ? [input.scheduleId] : [],
    );
    if (!schedules[0]) throw notFound('Schedule');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO open_shifts (schedule_id, tier_id, label_id, start_time, end_time, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        schedules[0].id,
        input.tierId,
        input.labelId,
        input.startTime,
        input.endTime,
        input.notes,
        admin.id,
      ],
    );
    const openShift = await getOpenShift(client, rows[0]!.id);
    const { rows: members } = await client.query<Reader & { name: string }>(
      `SELECT id, name, email, true AS active, timezone, time_format AS "timeFormat"
         FROM users
        WHERE tier_id = $1 AND deactivated_at IS NULL AND email_verified_at IS NOT NULL
          AND id <> $2`,
      [input.tierId, admin.id],
    );
    for (const member of members) {
      await notifyPerson(client, config, member, {
        kind: 'open_shift_posted',
        render: (ctx, prefs) =>
          openShiftPostedTemplate(ctx, {
            recipientName: member.name,
            shift: emailShift(openShift),
            tierName: openShift.tier.name,
            ...prefs,
          }),
      });
    }
    await audit(
      client,
      admin.id,
      'open_shift.posted',
      { type: 'open_shift', id: openShift.id },
      {
        tierName: openShift.tier.name,
        startTime: openShift.startTime,
        endTime: openShift.endTime,
        emails: members.length,
      },
    );
    return openShift.id;
  });
  return getOpenShift(db, id);
}

async function lockOpenShift(db: Queryable, id: string) {
  await expireStarted(db);
  const { rows } = await db.query<{
    id: string;
    status: OpenShiftStatus;
    tierId: string;
    scheduleId: string;
    claimedBy: string | null;
    declinedIds: string[];
  }>(
    `SELECT id, status, tier_id AS "tierId", schedule_id AS "scheduleId",
            claimed_by AS "claimedBy", declined_ids AS "declinedIds"
       FROM open_shifts WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!rows[0]) throw notFound('Open shift');
  return rows[0];
}

/**
 * Someone is free for it: no other shift or time off then (with the
 * builder's per-person lock). `name` is null when it's the reader.
 */
async function assertFree(db: Queryable, userId: string, name: string | null, o: OpenShift) {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shifts:${userId}`]);
  const busy = busyReason(
    await busyBetween(db, [userId], o.startTime, o.endTime),
    userId,
    o.startTime,
    o.endTime,
  );
  if (busy) {
    const working = busy === 'Working then';
    throw conflict(
      name
        ? `${name} ${working ? 'already has a shift' : 'has time off'} then`
        : `You ${working ? 'already have a shift' : 'have time off'} then`,
      'OPEN_SHIFT_BUSY',
    );
  }
}

const unavailable = (status: OpenShiftStatus) =>
  conflict(
    status === 'claimed'
      ? 'Someone already picked this shift up'
      : `This open shift is ${status === 'filled' ? 'taken' : status}`,
    'OPEN_SHIFT_TAKEN',
  );

/** The first person in the tier to pick it up holds it until an admin decides. */
export async function claimOpenShift(
  db: Db,
  config: Config,
  user: AuthUser,
  id: string,
): Promise<OpenShift> {
  await withTransaction(db, async (client) => {
    const locked = await lockOpenShift(client, id);
    if (locked.tierId !== user.tierId) throw notFound('Open shift');
    if (locked.status !== 'open') throw unavailable(locked.status);
    if (locked.declinedIds.includes(user.id)) {
      throw conflict('An admin already said no to you for this one', 'OPEN_SHIFT_DECLINED');
    }
    const openShift = await getOpenShift(client, id);
    await assertFree(client, user.id, null, openShift);
    await client.query(
      `UPDATE open_shifts SET status = 'claimed', claimed_by = $2, claimed_at = now()
        WHERE id = $1`,
      [id, user.id],
    );
    await notifyAdmins(client, config, {
      topic: 'swaps',
      exceptUserId: user.id,
      kind: 'open_shift_claimed',
      render: (ctx, admin) =>
        openShiftClaimedTemplate(ctx, {
          recipientName: admin.name,
          claimerName: user.name,
          shift: emailShift(openShift),
          tierName: openShift.tier.name,
          tz: admin.tz,
          timeFormat: admin.timeFormat,
        }),
    });
    await audit(
      client,
      user.id,
      'open_shift.claimed',
      { type: 'open_shift', id },
      { startTime: openShift.startTime, endTime: openShift.endTime },
    );
  });
  return getOpenShift(db, id);
}

/** Change your mind before an admin decides: it's open again. */
export async function releaseOpenShift(db: Db, user: AuthUser, id: string): Promise<OpenShift> {
  await withTransaction(db, async (client) => {
    const locked = await lockOpenShift(client, id);
    if (locked.claimedBy !== user.id) throw notFound('Open shift');
    if (locked.status !== 'claimed') throw unavailable(locked.status);
    await client.query(
      `UPDATE open_shifts SET status = 'open', claimed_by = NULL, claimed_at = NULL WHERE id = $1`,
      [id],
    );
    const openShift = await getOpenShift(client, id);
    await audit(
      client,
      user.id,
      'open_shift.released',
      { type: 'open_shift', id },
      { startTime: openShift.startTime, endTime: openShift.endTime },
    );
  });
  return getOpenShift(db, id);
}

/**
 * Approve (it becomes the person's shift, published and confirmed) or
 * decline (it's open again for everyone else).
 */
export async function reviewOpenShift(
  db: Db,
  config: Config,
  admin: AuthUser,
  id: string,
  decision: 'approved' | 'denied',
  note: string | null,
): Promise<OpenShift> {
  await withTransaction(db, async (client) => {
    const locked = await lockOpenShift(client, id);
    if (locked.status !== 'claimed' || !locked.claimedBy) throw unavailable(locked.status);
    const openShift = await getOpenShift(client, id);
    const claimer = await reader(client, locked.claimedBy);
    if (decision === 'approved') {
      const { rows } = await client.query<{ tierId: string | null }>(
        'SELECT tier_id AS "tierId" FROM users WHERE id = $1',
        [claimer.id],
      );
      if (!claimer.active || rows[0]?.tierId !== locked.tierId) {
        throw conflict(
          `${claimer.name} is no longer in ${openShift.tier.name}`,
          'OPEN_SHIFT_INELIGIBLE',
        );
      }
      await lockSchedule(client, locked.scheduleId);
      await assertFree(client, claimer.id, claimer.name, openShift);
      const { rows: created } = await client.query<{ id: string }>(
        `INSERT INTO shifts (schedule_id, user_id, label_id, start_time, end_time, notes,
                             status, confirmed_at, published_at, published_user_id,
                             published_label_id, published_start_time, published_end_time,
                             published_notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', now(), now(), $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          locked.scheduleId,
          claimer.id,
          openShift.label?.id ?? null,
          openShift.startTime,
          openShift.endTime,
          openShift.notes,
          admin.id,
        ],
      );
      await client.query(
        `UPDATE open_shifts SET status = 'filled', shift_id = $2, reviewed_by = $3,
                                reviewed_at = now()
          WHERE id = $1`,
        [id, created[0]!.id, admin.id],
      );
    } else {
      await client.query(
        `UPDATE open_shifts
            SET status = 'open', claimed_by = NULL, claimed_at = NULL,
                declined_ids = array_append(declined_ids, claimed_by),
                reviewed_by = $2, reviewed_at = now()
          WHERE id = $1`,
        [id, admin.id],
      );
    }
    if (claimer.id !== admin.id) {
      await notifyPerson(client, config, claimer, {
        kind: 'open_shift_reviewed',
        render: (ctx, prefs) =>
          openShiftReviewedTemplate(ctx, {
            recipientName: claimer.name,
            status: decision,
            reviewerName: admin.name,
            reviewNote: note,
            shift: emailShift(openShift),
            tierName: openShift.tier.name,
            ...prefs,
          }),
      });
    }
    await audit(
      client,
      admin.id,
      `open_shift.${decision}`,
      { type: 'open_shift', id },
      { personName: claimer.name, startTime: openShift.startTime, endTime: openShift.endTime },
    );
  });
  return getOpenShift(db, id);
}

/** Take an open shift down; whoever picked it up is told. */
export async function cancelOpenShift(
  db: Db,
  config: Config,
  admin: AuthUser,
  id: string,
): Promise<OpenShift> {
  await withTransaction(db, async (client) => {
    const locked = await lockOpenShift(client, id);
    if (locked.status !== 'open' && locked.status !== 'claimed') throw unavailable(locked.status);
    const openShift = await getOpenShift(client, id);
    await client.query(`UPDATE open_shifts SET status = 'cancelled' WHERE id = $1`, [id]);
    if (locked.claimedBy && locked.claimedBy !== admin.id) {
      const claimer = await reader(client, locked.claimedBy);
      await notifyPerson(client, config, claimer, {
        kind: 'open_shift_cancelled',
        render: (ctx, prefs) =>
          openShiftCancelledTemplate(ctx, {
            recipientName: claimer.name,
            shift: emailShift(openShift),
            tierName: openShift.tier.name,
            ...prefs,
          }),
      });
    }
    await audit(
      client,
      admin.id,
      'open_shift.cancelled',
      { type: 'open_shift', id },
      {
        tierName: openShift.tier.name,
        startTime: openShift.startTime,
        endTime: openShift.endTime,
      },
    );
  });
  return getOpenShift(db, id);
}
