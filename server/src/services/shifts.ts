import type { BuilderShift } from '@shared/types';
import { formatDay, formatShiftWhen, localDate } from '@shared/time';
import type { AuthUser } from '../auth/types';
import { withTransaction, type Db, type Queryable } from '../db';
import { badRequest, conflict, notFound } from '../errors';
import { getBuilderShift, lockSchedule, type LockedSchedule } from './schedules';
import { getSettings } from './settings';

const MAX_SHIFT_HOURS = 7 * 24;

export interface ShiftInput {
  userId: string;
  labelId: string | null;
  startTime: string;
  endTime: string;
  notes: string | null;
}

async function validateShift(
  db: Queryable,
  schedule: LockedSchedule,
  input: ShiftInput,
  opts: { excludeShiftId?: string; checkUser: boolean; checkLabel: boolean },
): Promise<void> {
  // Serialize edits per person so two concurrent saves can't both pass the overlap check.
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shifts:${input.userId}`]);
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

  const { timezone } = await getSettings(db);
  const day = localDate(input.startTime, timezone);
  if (day < schedule.startDate || day > schedule.endDate) {
    throw badRequest(
      `Shifts in this schedule must start between ${formatDay(schedule.startDate)} and ${formatDay(schedule.endDate)}`,
      { startTime: 'Outside the schedule dates' },
    );
  }

  const { rows: users } = await db.query<{ name: string; active: boolean }>(
    'SELECT name, (deactivated_at IS NULL) AS active FROM users WHERE id = $1',
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
    const { rows: labels } = await db.query<{ tierId: string | null }>(
      'SELECT tier_id AS "tierId" FROM labels WHERE id = $1',
      [input.labelId],
    );
    if (!labels[0]) throw notFound('Label');
    if (labels[0].tierId && labels[0].tierId !== schedule.tierId) {
      throw badRequest('That label belongs to a different tier', { labelId: 'Wrong tier' });
    }
  }

  const { rows: overlaps } = await db.query<{
    id: string;
    startTime: string;
    endTime: string;
    tierName: string;
  }>(
    `SELECT s.id, s.start_time AS "startTime", s.end_time AS "endTime", t.name AS "tierName"
       FROM shifts s
       JOIN schedules sc ON sc.id = s.schedule_id
       JOIN tiers t ON t.id = sc.tier_id
      WHERE s.user_id = $1 AND s.deleted_at IS NULL AND s.id IS DISTINCT FROM $4
        AND s.start_time < $3 AND s.end_time > $2
      ORDER BY s.start_time
      LIMIT 1`,
    [input.userId, input.startTime, input.endTime, opts.excludeShiftId ?? null],
  );
  const overlap = overlaps[0];
  if (overlap) {
    throw conflict(
      `${user.name} already has a ${overlap.tierName} shift ${formatShiftWhen(overlap.startTime, overlap.endTime, timezone)} that overlaps this one`,
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
    const schedule = await lockSchedule(client, scheduleId);
    await validateShift(client, schedule, input, { checkUser: true, checkLabel: true });
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
    const schedule = await lockSchedule(client, rows[0].scheduleId);
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
    await validateShift(client, schedule, next, {
      excludeShiftId: shiftId,
      checkUser: next.userId !== current.userId,
      checkLabel: next.labelId !== current.labelId,
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
    const schedule = await lockSchedule(client, rows[0].scheduleId);
    const current = await lockShift(client, shiftId);
    if (!current.deletedAt) return;
    await validateShift(client, schedule, current, {
      excludeShiftId: shiftId,
      checkUser: false,
      checkLabel: false,
    });
    await client.query('UPDATE shifts SET deleted_at = NULL WHERE id = $1', [shiftId]);
  });
  return getBuilderShift(db, shiftId);
}
