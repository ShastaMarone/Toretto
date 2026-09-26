import { formatShiftWhen, localDate } from '@shared/time';
import type { BuilderShift, RepeatResult } from '@shared/types';
import type { AuthUser } from '../auth/types';
import { withTransaction, type Db, type Queryable } from '../db';
import { badRequest, conflict, notFound } from '../errors';
import { getBuilderShift, lockSchedule } from './schedules';
import { getSettings } from './settings';

const MAX_SHIFT_HOURS = 7 * 24;

export interface ShiftInput {
  userId: string;
  labelId: string | null;
  startTime: string;
  endTime: string;
  notes: string | null;
}

function checkTimes(input: { startTime: string; endTime: string }): void {
  const start = Date.parse(input.startTime);
  const end = Date.parse(input.endTime);
  if (!(end > start)) {
    throw badRequest('A shift must end after it starts', {
      endTime: 'Must be after the start time',
    });
  }
  if (end - start > MAX_SHIFT_HOURS * 3_600_000) {
    throw badRequest('A shift can be at most 7 days long', { endTime: 'Too long' });
  }
}

/**
 * Lock the person's shifts (so two concurrent saves can't both pass the
 * overlap check), then check they can be scheduled and can have the label.
 */
async function checkPersonAndLabel(
  db: Queryable,
  input: ShiftInput,
  opts: { checkUser: boolean; checkLabel: boolean },
): Promise<{ name: string }> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shifts:${input.userId}`]);
  const { rows: users } = await db.query<{
    name: string;
    active: boolean;
    tierId: string | null;
  }>(
    'SELECT name, (deactivated_at IS NULL) AS active, tier_id AS "tierId" FROM users WHERE id = $1',
    [input.userId],
  );
  const user = users[0];
  if (!user) throw notFound('Person');
  if (opts.checkUser && !user.active) {
    throw badRequest(`${user.name} is deactivated and can't be scheduled`, {
      userId: 'Deactivated',
    });
  }

  if (input.labelId && opts.checkLabel) {
    const { rows: labels } = await db.query<{
      name: string;
      tierId: string | null;
      tierName: string | null;
    }>(
      `SELECT l.name, l.tier_id AS "tierId", t.name AS "tierName"
         FROM labels l LEFT JOIN tiers t ON t.id = l.tier_id WHERE l.id = $1`,
      [input.labelId],
    );
    const label = labels[0];
    if (!label) throw notFound('Label');
    // Tier-specific labels are only for people in that tier.
    if (label.tierId && label.tierId !== user.tierId) {
      throw badRequest(
        `${label.name} is a ${label.tierName} label, and ${user.name} isn't in ${label.tierName}`,
        {
          labelId: 'Wrong tier',
        },
      );
    }
  }
  return user;
}

interface Overlap {
  id: string;
  startTime: string;
  endTime: string;
  scheduleName: string;
  otherSchedule: boolean;
}

/** The person's first other shift (on any schedule) that overlaps this one. */
async function findOverlap(
  db: Queryable,
  input: ShiftInput,
  opts: { scheduleId?: string; excludeShiftId?: string },
): Promise<Overlap | undefined> {
  const { rows } = await db.query<Overlap>(
    `SELECT s.id, s.start_time AS "startTime", s.end_time AS "endTime",
            sc.name AS "scheduleName", (sc.id IS DISTINCT FROM $5) AS "otherSchedule"
       FROM shifts s
       JOIN schedules sc ON sc.id = s.schedule_id
      WHERE s.user_id = $1 AND s.deleted_at IS NULL AND s.id IS DISTINCT FROM $4
        AND s.start_time < $3 AND s.end_time > $2
      ORDER BY s.start_time
      LIMIT 1`,
    [
      input.userId,
      input.startTime,
      input.endTime,
      opts.excludeShiftId ?? null,
      opts.scheduleId ?? null,
    ],
  );
  return rows[0];
}

async function validateShift(
  db: Queryable,
  input: ShiftInput,
  opts: { scheduleId?: string; excludeShiftId?: string; checkUser: boolean; checkLabel: boolean },
): Promise<void> {
  checkTimes(input);
  const user = await checkPersonAndLabel(db, input, opts);
  const overlap = await findOverlap(db, input, opts);
  if (overlap) {
    const { timezone, timeFormat } = await getSettings(db);
    const where = overlap.otherSchedule ? ` on ${overlap.scheduleName}` : '';
    throw conflict(
      `${user.name} already has a shift${where} ${formatShiftWhen(overlap.startTime, overlap.endTime, timezone, timeFormat)} that overlaps this one`,
      'SHIFT_OVERLAP',
      { shiftId: overlap.id },
    );
  }
}

export async function createShift(
  db: Db,
  actor: AuthUser,
  scheduleId: string,
  input: ShiftInput,
): Promise<BuilderShift> {
  const id = await withTransaction(db, async (client) => {
    await lockSchedule(client, scheduleId);
    await validateShift(client, input, { scheduleId, checkUser: true, checkLabel: true });
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO shifts (schedule_id, user_id, label_id, start_time, end_time, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        scheduleId,
        input.userId,
        input.labelId,
        input.startTime,
        input.endTime,
        input.notes,
        actor.id,
      ],
    );
    return rows[0]!.id;
  });
  return getBuilderShift(db, id);
}

export interface RepeatInput {
  userId: string;
  labelId: string | null;
  notes: string | null;
  shifts: { startTime: string; endTime: string }[];
}

/**
 * Add the same shift on several days at once (a repeating shift). Each one is
 * an ordinary draft, edited on its own afterwards. Days when the person
 * already works, or has approved time off, are skipped and reported.
 */
export async function createShifts(
  db: Db,
  actor: AuthUser,
  scheduleId: string,
  input: RepeatInput,
): Promise<RepeatResult> {
  return withTransaction(db, async (client) => {
    await lockSchedule(client, scheduleId);
    const times = [...input.shifts].sort((a, b) => a.startTime.localeCompare(b.startTime));
    times.forEach(checkTimes);
    await checkPersonAndLabel(
      client,
      { ...input, ...times[0]! },
      { checkUser: true, checkLabel: true },
    );
    const { timezone } = await getSettings(client);
    const days = times.map((t) => localDate(t.startTime, timezone));
    const { rows: timeOff } = await client.query<{
      startDate: string;
      endDate: string;
      typeName: string;
    }>(
      `SELECT r.start_date AS "startDate", r.end_date AS "endDate", tt.name AS "typeName"
         FROM time_off_requests r JOIN time_off_types tt ON tt.id = r.type_id
        WHERE r.user_id = $1 AND r.status = 'approved' AND r.start_date <= $3 AND r.end_date >= $2`,
      [input.userId, days[0], days[days.length - 1]],
    );

    const result: RepeatResult = { created: 0, skipped: [] };
    for (const [i, time] of times.entries()) {
      const day = days[i]!;
      const off = timeOff.find((t) => t.startDate <= day && t.endDate >= day);
      if (off) {
        result.skipped.push({ ...time, reason: 'time_off', detail: off.typeName });
        continue;
      }
      // Earlier days of this repeat count too (they're in the same transaction).
      const overlap = await findOverlap(client, { ...input, ...time }, { scheduleId });
      if (overlap) {
        result.skipped.push({
          ...time,
          reason: 'overlap',
          detail: overlap.otherSchedule
            ? `already has a shift on ${overlap.scheduleName}`
            : 'already has a shift',
        });
        continue;
      }
      await client.query(
        `INSERT INTO shifts (schedule_id, user_id, label_id, start_time, end_time, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          scheduleId,
          input.userId,
          input.labelId,
          time.startTime,
          time.endTime,
          input.notes,
          actor.id,
        ],
      );
      result.created++;
    }
    return result;
  });
}

async function lockShift(client: Queryable, id: string) {
  const { rows } = await client.query<
    ShiftInput & { scheduleId: string; deletedAt: string | null }
  >(
    `SELECT schedule_id AS "scheduleId", user_id AS "userId", label_id AS "labelId",
            start_time AS "startTime", end_time AS "endTime", notes, deleted_at AS "deletedAt"
       FROM shifts WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!rows[0]) throw notFound('Shift');
  return rows[0];
}

export async function updateShift(
  db: Db,
  shiftId: string,
  patch: Partial<ShiftInput>,
): Promise<BuilderShift> {
  await withTransaction(db, async (client) => {
    const { rows } = await client.query<{ scheduleId: string }>(
      'SELECT schedule_id AS "scheduleId" FROM shifts WHERE id = $1',
      [shiftId],
    );
    if (!rows[0]) throw notFound('Shift');
    // Lock order: schedule, then shift (same as publish) to avoid deadlocks.
    await lockSchedule(client, rows[0].scheduleId);
    const current = await lockShift(client, shiftId);
    if (current.deletedAt)
      throw conflict('This shift was deleted. Restore it before editing.', 'SHIFT_DELETED');
    const next: ShiftInput = {
      userId: patch.userId ?? current.userId,
      labelId: patch.labelId !== undefined ? patch.labelId : current.labelId,
      startTime: patch.startTime ?? current.startTime,
      endTime: patch.endTime ?? current.endTime,
      notes: patch.notes !== undefined ? patch.notes : current.notes,
    };
    await validateShift(client, next, {
      scheduleId: current.scheduleId,
      excludeShiftId: shiftId,
      checkUser: next.userId !== current.userId,
      // A tier label has to fit whoever the shift now belongs to.
      checkLabel: next.labelId !== current.labelId || next.userId !== current.userId,
    });
    await client.query(
      `UPDATE shifts SET user_id = $2, label_id = $3, start_time = $4, end_time = $5, notes = $6
        WHERE id = $1`,
      [shiftId, next.userId, next.labelId, next.startTime, next.endTime, next.notes],
    );
  });
  return getBuilderShift(db, shiftId);
}

/**
 * Delete a shift. Never-published shifts disappear immediately; published ones
 * are only marked, so the team keeps seeing them until the change is published.
 */
export async function deleteShift(db: Db, shiftId: string): Promise<{ pendingRemoval: boolean }> {
  return withTransaction(db, async (client) => {
    const { rows } = await client.query<{ scheduleId: string }>(
      'SELECT schedule_id AS "scheduleId" FROM shifts WHERE id = $1',
      [shiftId],
    );
    if (!rows[0]) throw notFound('Shift');
    await lockSchedule(client, rows[0].scheduleId);
    const { rows: deleted } = await client.query(
      'DELETE FROM shifts WHERE id = $1 AND published_at IS NULL RETURNING id',
      [shiftId],
    );
    if (deleted.length) return { pendingRemoval: false };
    await client.query(
      'UPDATE shifts SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL',
      [shiftId],
    );
    return { pendingRemoval: true };
  });
}

/** Undo a pending removal of a published shift. */
export async function restoreShift(db: Db, shiftId: string): Promise<BuilderShift> {
  await withTransaction(db, async (client) => {
    const { rows } = await client.query<{ scheduleId: string }>(
      'SELECT schedule_id AS "scheduleId" FROM shifts WHERE id = $1',
      [shiftId],
    );
    if (!rows[0]) throw notFound('Shift');
    await lockSchedule(client, rows[0].scheduleId);
    const current = await lockShift(client, shiftId);
    if (!current.deletedAt) return;
    await validateShift(client, current, {
      scheduleId: current.scheduleId,
      excludeShiftId: shiftId,
      checkUser: false,
      checkLabel: false,
    });
    await client.query('UPDATE shifts SET deleted_at = NULL WHERE id = $1', [shiftId]);
  });
  return getBuilderShift(db, shiftId);
}
