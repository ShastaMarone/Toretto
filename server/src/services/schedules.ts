import type {
  BuilderShift,
  ChangeCounts,
  ChangeState,
  CopyResult,
  Label,
  PersonRow,
  ScheduleRange,
  ScheduleSummary,
  TimeOffEntry,
} from '@shared/types';
import { addDays, dayRangeToUtc, diffDays, localDate, moveShiftToDate } from '@shared/time';
import type { AuthUser } from '../auth/types';
import { withTransaction, type Db, type Queryable } from '../db';
import { badRequest, conflict, notFound } from '../errors';
import { audit } from './audit';
import { getSettings } from './settings';

/** Longest range the builder loads, publishes or copies at once. */
export const MAX_RANGE_DAYS = 62;

/** True when a shift's working copy differs from what the team sees. */
export const HAS_UNPUBLISHED_CHANGE = `(
  s.deleted_at IS NOT NULL OR s.published_at IS NULL
  OR s.user_id IS DISTINCT FROM s.published_user_id
  OR s.label_id IS DISTINCT FROM s.published_label_id
  OR s.start_time IS DISTINCT FROM s.published_start_time
  OR s.end_time IS DISTINCT FROM s.published_end_time
  OR s.notes IS DISTINCT FROM s.published_notes)`;

/**
 * A shift belongs to a date range when its working copy or the published
 * version the team sees starts in it ($2 and $3 are the UTC bounds).
 */
export const IN_RANGE = `(
  (s.deleted_at IS NULL AND s.start_time >= $2 AND s.start_time < $3)
  OR (s.published_at IS NOT NULL AND s.published_start_time >= $2 AND s.published_start_time < $3))`;

const SUMMARY_SQL = `
  SELECT sc.id, sc.name, sc.is_default AS "isDefault",
         sc.published_at AS "publishedAt", pb.name AS "publishedByName",
         count(s.id) FILTER (WHERE ${HAS_UNPUBLISHED_CHANGE})::int AS "pendingChanges",
         min((LEAST(CASE WHEN s.deleted_at IS NULL THEN s.start_time END, s.published_start_time)
              AT TIME ZONE os.timezone)::date) FILTER (WHERE ${HAS_UNPUBLISHED_CHANGE}) AS "firstChangeDate",
         max((GREATEST(CASE WHEN s.deleted_at IS NULL THEN s.start_time END, s.published_start_time)
              AT TIME ZONE os.timezone)::date) FILTER (WHERE ${HAS_UNPUBLISHED_CHANGE}) AS "lastChangeDate",
         sc.created_at AS "createdAt"
    FROM schedules sc
    CROSS JOIN org_settings os
    LEFT JOIN users pb ON pb.id = sc.published_by
    LEFT JOIN shifts s ON s.schedule_id = sc.id`;
const SUMMARY_GROUP = 'GROUP BY sc.id, pb.id';

/** The default schedule's id, creating it if it's missing (e.g. after a wipe). */
export async function ensureDefaultSchedule(db: Queryable): Promise<string> {
  await db.query(
    `INSERT INTO schedules (name, is_default) VALUES ('Main schedule', true)
     ON CONFLICT (is_default) WHERE is_default DO NOTHING`,
  );
  const { rows } = await db.query<{ id: string }>('SELECT id FROM schedules WHERE is_default');
  return rows[0]!.id;
}

export async function listSchedules(db: Queryable): Promise<ScheduleSummary[]> {
  const { rows } = await db.query<ScheduleSummary>(
    `${SUMMARY_SQL} ${SUMMARY_GROUP} ORDER BY sc.is_default DESC, lower(sc.name)`,
  );
  return rows;
}

export async function getScheduleSummary(db: Queryable, id: string): Promise<ScheduleSummary> {
  const { rows } = await db.query<ScheduleSummary>(
    `${SUMMARY_SQL} WHERE sc.id = $1 ${SUMMARY_GROUP}`,
    [id],
  );
  if (!rows[0]) throw notFound('Schedule');
  return rows[0];
}

export interface LockedSchedule {
  id: string;
  name: string;
  isDefault: boolean;
}

/** Load a schedule and lock its row for the rest of the transaction. */
export async function lockSchedule(db: Queryable, id: string): Promise<LockedSchedule> {
  const { rows } = await db.query<LockedSchedule>(
    `SELECT id, name, is_default AS "isDefault" FROM schedules WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!rows[0]) throw notFound('Schedule');
  return rows[0];
}

export interface DateRange {
  from: string;
  to: string;
}

/** Validate a range of organization calendar days and return its UTC bounds. */
export function rangeBounds(range: DateRange, tz: string): { from: string; to: string } {
  if (range.to < range.from) throw badRequest('The last day must be on or after the first day');
  if (diffDays(range.from, range.to) >= MAX_RANGE_DAYS) {
    throw badRequest(`Pick at most ${MAX_RANGE_DAYS} days at a time`);
  }
  return dayRangeToUtc(range.from, range.to, tz);
}

// ---------------------------------------------------------------------------
// Builder data for a date range
// ---------------------------------------------------------------------------

interface ShiftRow {
  id: string;
  scheduleId: string;
  userId: string;
  labelId: string | null;
  startTime: string;
  endTime: string;
  notes: string | null;
  status: BuilderShift['status'];
  confirmedAt: string | null;
  publishedAt: string | null;
  pUserId: string | null;
  pLabelId: string | null;
  pStart: string | null;
  pEnd: string | null;
  pNotes: string | null;
  deletedAt: string | null;
}

const SHIFT_ROW_SQL = `
  SELECT s.id, s.schedule_id AS "scheduleId", s.user_id AS "userId", s.label_id AS "labelId",
         s.start_time AS "startTime", s.end_time AS "endTime", s.notes, s.status,
         s.confirmed_at AS "confirmedAt", s.published_at AS "publishedAt",
         s.published_user_id AS "pUserId", s.published_label_id AS "pLabelId",
         s.published_start_time AS "pStart", s.published_end_time AS "pEnd",
         s.published_notes AS "pNotes", s.deleted_at AS "deletedAt"
    FROM shifts s`;

function toBuilderShift(row: ShiftRow): BuilderShift {
  const published = row.publishedAt
    ? {
        userId: row.pUserId!,
        labelId: row.pLabelId,
        startTime: row.pStart!,
        endTime: row.pEnd!,
        notes: row.pNotes,
      }
    : null;
  let changeState: ChangeState;
  if (row.deletedAt) changeState = 'removed';
  else if (!published) changeState = 'new';
  else if (
    published.userId !== row.userId ||
    published.labelId !== row.labelId ||
    published.startTime !== row.startTime ||
    published.endTime !== row.endTime ||
    published.notes !== row.notes
  )
    changeState = 'updated';
  else changeState = 'unchanged';
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    userId: row.userId,
    labelId: row.labelId,
    startTime: row.startTime,
    endTime: row.endTime,
    notes: row.notes,
    status: row.status,
    confirmedAt: row.confirmedAt,
    changeState,
    published,
  };
}

export async function getBuilderShift(db: Queryable, id: string): Promise<BuilderShift> {
  const { rows } = await db.query<ShiftRow>(`${SHIFT_ROW_SQL} WHERE s.id = $1`, [id]);
  if (!rows[0]) throw notFound('Shift');
  return toBuilderShift(rows[0]);
}

export const LABEL_SQL = `
  SELECT l.id, l.tier_id AS "tierId", l.name, l.color,
         (SELECT count(*)::int FROM shifts s WHERE s.label_id = l.id AND s.deleted_at IS NULL) AS "shiftCount"
    FROM labels l`;

export async function getScheduleRange(
  db: Queryable,
  id: string,
  range: DateRange,
): Promise<ScheduleRange> {
  const { timezone } = await getSettings(db);
  const bounds = rangeBounds(range, timezone);
  const schedule = await getScheduleSummary(db, id);
  const { rows: shiftRows } = await db.query<ShiftRow>(
    `${SHIFT_ROW_SQL}
      WHERE s.schedule_id = $1 AND ${IN_RANGE}
      ORDER BY s.start_time, s.id`,
    [id, bounds.from, bounds.to],
  );
  const all = shiftRows.map(toBuilderShift);
  const [fromMs, toMs] = [Date.parse(bounds.from), Date.parse(bounds.to)];
  const inRange = (s: BuilderShift) =>
    s.changeState !== 'removed' &&
    Date.parse(s.startTime) >= fromMs &&
    Date.parse(s.startTime) < toMs;
  const shifts = all.filter(inRange);
  const removedShifts = all.filter((s) => !inRange(s));

  const { rows: people } = await db.query<PersonRow>(
    `SELECT u.id, u.name, u.tier_id AS "tierId", u.team_id AS "teamId",
            (u.deactivated_at IS NULL) AS active
       FROM users u
      WHERE u.deactivated_at IS NULL OR u.id = ANY($1)
      ORDER BY lower(u.name)`,
    [[...new Set(all.flatMap((s) => [s.userId, s.published?.userId ?? s.userId]))]],
  );

  const { rows: labels } = await db.query<Label>(
    `${LABEL_SQL} ORDER BY (l.tier_id IS NULL) DESC, lower(l.name)`,
  );

  const { rows: timeOff } = await db.query<TimeOffEntry>(
    `SELECT r.id, r.user_id AS "userId", r.start_date AS "startDate", r.end_date AS "endDate",
            r.status, tt.name AS "typeName", tt.color AS "typeColor"
       FROM time_off_requests r JOIN time_off_types tt ON tt.id = r.type_id
      WHERE r.user_id = ANY($1) AND r.status IN ('pending', 'approved')
        AND r.start_date <= $3 AND r.end_date >= $2
      ORDER BY r.start_date`,
    [people.map((p) => p.id), range.from, range.to],
  );

  const changes: ChangeCounts = { added: 0, updated: 0, removed: 0, total: 0 };
  for (const s of all) {
    if (s.changeState === 'new') changes.added++;
    else if (s.changeState === 'updated') changes.updated++;
    else if (s.changeState === 'removed') changes.removed++;
  }
  changes.total = changes.added + changes.updated + changes.removed;

  return {
    schedule,
    from: range.from,
    to: range.to,
    shifts,
    removedShifts,
    people,
    labels,
    timeOff,
    changes,
  };
}

// ---------------------------------------------------------------------------
// Create, rename, copy
// ---------------------------------------------------------------------------

function nameTaken(err: unknown): boolean {
  return (err as { code?: string; constraint?: string })?.constraint === 'schedules_name_unique';
}

export async function createSchedule(
  db: Db,
  actor: AuthUser,
  input: { name: string },
): Promise<ScheduleSummary> {
  try {
    const id = await withTransaction(db, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO schedules (name, created_by) VALUES ($1, $2) RETURNING id',
        [input.name, actor.id],
      );
      const scheduleId = rows[0]!.id;
      await audit(
        client,
        actor.id,
        'schedule.created',
        { type: 'schedule', id: scheduleId },
        { title: input.name },
      );
      return scheduleId;
    });
    return getScheduleSummary(db, id);
  } catch (err) {
    if (nameTaken(err)) throw conflict('There is already a schedule with that name.', 'NAME_TAKEN');
    throw err;
  }
}

export async function renameSchedule(
  db: Db,
  actor: AuthUser,
  id: string,
  name: string,
): Promise<ScheduleSummary> {
  try {
    await withTransaction(db, async (client) => {
      const schedule = await lockSchedule(client, id);
      await client.query('UPDATE schedules SET name = $2 WHERE id = $1', [id, name]);
      await audit(
        client,
        actor.id,
        'schedule.renamed',
        { type: 'schedule', id },
        { title: name, previous: schedule.name },
      );
    });
  } catch (err) {
    if (nameTaken(err)) throw conflict('There is already a schedule with that name.', 'NAME_TAKEN');
    throw err;
  }
  return getScheduleSummary(db, id);
}

/**
 * Copy the shifts in one range of days into the same number of days starting
 * at `targetStart`, as unpublished additions. Each copy keeps its weekday
 * offset, wall-clock times, person, label and note. Copies that would
 * double-book someone, or are for deactivated people, are skipped.
 */
export async function copyShifts(
  db: Db,
  actor: AuthUser,
  scheduleId: string,
  input: { from: string; to: string; targetStart: string },
): Promise<CopyResult> {
  return withTransaction(db, async (client) => {
    const schedule = await lockSchedule(client, scheduleId);
    const { timezone } = await getSettings(client);
    const source = rangeBounds(input, timezone);
    const offset = diffDays(input.from, input.targetStart);
    const targetEnd = addDays(input.to, offset);
    if (offset === 0) throw badRequest('Pick a different week to copy into');
    if (input.targetStart <= input.to && targetEnd >= input.from) {
      throw badRequest("The days you copy into can't overlap the days you copy from");
    }
    const { rows: shifts } = await client.query<{
      userId: string;
      labelId: string | null;
      startTime: string;
      endTime: string;
      notes: string | null;
      active: boolean;
    }>(
      `SELECT s.user_id AS "userId", s.label_id AS "labelId",
              s.start_time AS "startTime", s.end_time AS "endTime", s.notes,
              (u.deactivated_at IS NULL) AS active
         FROM shifts s JOIN users u ON u.id = s.user_id
        WHERE s.schedule_id = $1 AND s.deleted_at IS NULL
          AND s.start_time >= $2 AND s.start_time < $3
        ORDER BY s.start_time`,
      [scheduleId, source.from, source.to],
    );
    // Same per-person locks as single-shift edits (sorted to avoid deadlocks),
    // so the overlap checks below can't race a concurrent edit.
    for (const userId of [...new Set(shifts.map((s) => s.userId))].sort()) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shifts:${userId}`]);
    }
    let copied = 0;
    let skipped = 0;
    for (const shift of shifts) {
      const day = addDays(localDate(shift.startTime, timezone), offset);
      const moved = moveShiftToDate(shift.startTime, shift.endTime, day, timezone);
      const { rows: overlap } = await client.query(
        `SELECT 1 FROM shifts WHERE user_id = $1 AND deleted_at IS NULL
            AND start_time < $3 AND end_time > $2 LIMIT 1`,
        [shift.userId, moved.startTime, moved.endTime],
      );
      if (!shift.active || overlap.length) {
        skipped++;
        continue;
      }
      await client.query(
        `INSERT INTO shifts (schedule_id, user_id, label_id, start_time, end_time, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          scheduleId,
          shift.userId,
          shift.labelId,
          moved.startTime,
          moved.endTime,
          shift.notes,
          actor.id,
        ],
      );
      copied++;
    }
    await audit(
      client,
      actor.id,
      'schedule.copied',
      { type: 'schedule', id: scheduleId },
      {
        title: schedule.name,
        from: input.from,
        to: input.to,
        targetStart: input.targetStart,
        copied,
      },
    );
    return { copied, skipped };
  });
}
