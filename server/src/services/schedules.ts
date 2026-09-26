import type {
  BuilderShift,
  ChangeCounts,
  ChangeState,
  CreateScheduleResult,
  Label,
  PersonRow,
  ScheduleDetail,
  ScheduleStatus,
  ScheduleSummary,
  TimeOffEntry,
} from '@shared/types';
import { addDays, diffDays, formatDateRange, localDate, moveShiftToDate } from '@shared/time';
import type { AuthUser } from '../auth/types';
import { withTransaction, type Db, type Queryable } from '../db';
import { badRequest, conflict, notFound } from '../errors';
import { audit } from './audit';
import { getSettings } from './settings';

/** True when a shift's working copy differs from what the team sees. */
export const HAS_UNPUBLISHED_CHANGE = `(
  s.deleted_at IS NOT NULL OR s.published_at IS NULL
  OR s.user_id IS DISTINCT FROM s.published_user_id
  OR s.label_id IS DISTINCT FROM s.published_label_id
  OR s.start_time IS DISTINCT FROM s.published_start_time
  OR s.end_time IS DISTINCT FROM s.published_end_time
  OR s.notes IS DISTINCT FROM s.published_notes)`;

const SUMMARY_SQL = `
  SELECT sc.id, sc.tier_id AS "tierId", t.name AS "tierName", t.color AS "tierColor", sc.name,
         sc.start_date AS "startDate", sc.end_date AS "endDate", sc.status,
         sc.published_at AS "publishedAt", pb.name AS "publishedByName",
         count(s.id) FILTER (WHERE s.deleted_at IS NULL)::int AS "shiftCount",
         count(s.id) FILTER (WHERE s.published_at IS NOT NULL AND s.deleted_at IS NULL
                               AND s.status = 'confirmed')::int AS "confirmedCount",
         count(s.id) FILTER (WHERE s.published_at IS NOT NULL AND s.deleted_at IS NULL
                               AND s.status = 'pending')::int AS "pendingCount",
         count(s.id) FILTER (WHERE ${HAS_UNPUBLISHED_CHANGE})::int AS "pendingChanges",
         sc.updated_at AS "updatedAt"
    FROM schedules sc
    JOIN tiers t ON t.id = sc.tier_id
    LEFT JOIN users pb ON pb.id = sc.published_by
    LEFT JOIN shifts s ON s.schedule_id = sc.id`;
const SUMMARY_GROUP = 'GROUP BY sc.id, t.id, pb.id';

export async function listSchedules(
  db: Queryable,
  filters: { tierId?: string; status?: ScheduleStatus; endingAfter?: string } = {},
): Promise<ScheduleSummary[]> {
  const { rows } = await db.query<ScheduleSummary>(
    `${SUMMARY_SQL}
      WHERE ($1::uuid IS NULL OR sc.tier_id = $1)
        AND ($2::text IS NULL OR sc.status = $2)
        AND ($3::date IS NULL OR sc.end_date >= $3)
      ${SUMMARY_GROUP}
      ORDER BY sc.start_date DESC, t.sort_order, t.name`,
    [filters.tierId ?? null, filters.status ?? null, filters.endingAfter ?? null],
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
  tierId: string;
  tierName: string;
  name: string | null;
  startDate: string;
  endDate: string;
  status: ScheduleStatus;
}

/** Load a schedule and lock its row for the rest of the transaction. */
export async function lockSchedule(db: Queryable, id: string): Promise<LockedSchedule> {
  const { rows } = await db.query<LockedSchedule>(
    `SELECT sc.id, sc.tier_id AS "tierId", t.name AS "tierName", sc.name,
            sc.start_date AS "startDate", sc.end_date AS "endDate", sc.status
       FROM schedules sc JOIN tiers t ON t.id = sc.tier_id
      WHERE sc.id = $1
        FOR UPDATE OF sc`,
    [id],
  );
  if (!rows[0]) throw notFound('Schedule');
  return rows[0];
}

export function scheduleTitle(s: { tierName: string; startDate: string; endDate: string }): string {
  return `${s.tierName} · ${formatDateRange(s.startDate, s.endDate)}`;
}

export async function assertNoScheduleOverlap(
  db: Queryable,
  tierId: string,
  startDate: string,
  endDate: string,
  excludeId: string | null = null,
): Promise<void> {
  const { rows } = await db.query<{ startDate: string; endDate: string }>(
    `SELECT start_date AS "startDate", end_date AS "endDate" FROM schedules
      WHERE tier_id = $1 AND id IS DISTINCT FROM $4 AND start_date <= $3 AND end_date >= $2
      LIMIT 1`,
    [tierId, startDate, endDate, excludeId],
  );
  if (rows[0]) {
    throw conflict(
      `This tier already has a schedule for ${formatDateRange(rows[0].startDate, rows[0].endDate)}. Schedules for the same tier can't overlap.`,
      'SCHEDULE_OVERLAP',
    );
  }
}

// ---------------------------------------------------------------------------
// Builder detail
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

export async function getScheduleDetail(db: Queryable, id: string): Promise<ScheduleDetail> {
  const schedule = await getScheduleSummary(db, id);
  const { rows: shiftRows } = await db.query<ShiftRow>(
    `${SHIFT_ROW_SQL} WHERE s.schedule_id = $1 ORDER BY s.start_time, s.id`,
    [id],
  );
  const shifts = shiftRows.map(toBuilderShift);

  const { rows: members } = await db.query<PersonRow>(
    `SELECT u.id, u.name, u.tier_id AS "tierId", u.team_id AS "teamId",
            (u.deactivated_at IS NULL) AS active
       FROM users u
      WHERE (u.tier_id = $1 AND u.deactivated_at IS NULL)
         OR u.id IN (SELECT user_id FROM shifts WHERE schedule_id = $2
                     UNION
                     SELECT published_user_id FROM shifts
                      WHERE schedule_id = $2 AND published_user_id IS NOT NULL)
      ORDER BY lower(u.name)`,
    [schedule.tierId, id],
  );

  const { rows: labels } = await db.query<Label>(
    `${LABEL_SQL} WHERE l.tier_id = $1 OR l.tier_id IS NULL ORDER BY (l.tier_id IS NULL), lower(l.name)`,
    [schedule.tierId],
  );

  const { rows: timeOff } = await db.query<TimeOffEntry>(
    `SELECT r.id, r.user_id AS "userId", r.start_date AS "startDate", r.end_date AS "endDate",
            r.status, tt.name AS "typeName", tt.color AS "typeColor"
       FROM time_off_requests r JOIN time_off_types tt ON tt.id = r.type_id
      WHERE r.user_id = ANY($1) AND r.status IN ('pending', 'approved')
        AND r.start_date <= $3 AND r.end_date >= $2
      ORDER BY r.start_date`,
    [members.map((m) => m.id), schedule.startDate, schedule.endDate],
  );

  const changes: ChangeCounts = { added: 0, updated: 0, removed: 0, total: 0 };
  for (const s of shifts) {
    if (s.changeState === 'new') changes.added++;
    else if (s.changeState === 'updated') changes.updated++;
    else if (s.changeState === 'removed') changes.removed++;
  }
  changes.total = changes.added + changes.updated + changes.removed;

  return {
    schedule,
    shifts: shifts.filter((s) => s.changeState !== 'removed'),
    removedShifts: shifts.filter((s) => s.changeState === 'removed'),
    members,
    labels,
    timeOff,
    changes,
  };
}

// ---------------------------------------------------------------------------
// Create (optionally copying another schedule's shifts)
// ---------------------------------------------------------------------------

export interface CreateScheduleInput {
  tierId: string;
  startDate: string;
  endDate: string;
  name: string | null;
  copyFromScheduleId: string | null;
}

export async function createSchedule(
  db: Db,
  actor: AuthUser,
  input: CreateScheduleInput,
): Promise<CreateScheduleResult> {
  if (input.endDate < input.startDate)
    throw badRequest('End date must be on or after the start date');
  if (diffDays(input.startDate, input.endDate) >= 42) {
    throw badRequest('A schedule can cover at most 6 weeks');
  }
  const { id, copied, skipped } = await withTransaction(db, async (client) => {
    const { rows: tiers } = await client.query<{ id: string; name: string }>(
      'SELECT id, name FROM tiers WHERE id = $1 FOR SHARE',
      [input.tierId],
    );
    const tier = tiers[0];
    if (!tier) throw notFound('Tier');
    // Serialize schedule creation per tier so the overlap check is reliable.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`schedule:${tier.id}`]);
    await assertNoScheduleOverlap(client, tier.id, input.startDate, input.endDate);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO schedules (tier_id, name, start_date, end_date, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tier.id, input.name, input.startDate, input.endDate, actor.id],
    );
    const scheduleId = rows[0]!.id;
    const result = input.copyFromScheduleId
      ? await copyShifts(client, input.copyFromScheduleId, scheduleId, tier.id, input, actor)
      : { copied: 0, skipped: 0 };
    await audit(
      client,
      actor.id,
      'schedule.created',
      { type: 'schedule', id: scheduleId },
      {
        title: `${tier.name} · ${formatDateRange(input.startDate, input.endDate)}`,
        copied: result.copied,
      },
    );
    return { id: scheduleId, ...result };
  });
  return { schedule: await getScheduleSummary(db, id), copied, skipped };
}

async function copyShifts(
  client: Queryable,
  sourceId: string,
  targetId: string,
  targetTierId: string,
  target: { startDate: string; endDate: string },
  actor: AuthUser,
): Promise<{ copied: number; skipped: number }> {
  const { rows: sources } = await client.query<{ startDate: string }>(
    'SELECT start_date AS "startDate" FROM schedules WHERE id = $1',
    [sourceId],
  );
  if (!sources[0]) throw notFound('Schedule to copy from');
  const { timezone } = await getSettings(client);
  const offset = diffDays(sources[0].startDate, target.startDate);
  const { rows: shifts } = await client.query<{
    userId: string;
    labelId: string | null;
    labelTierId: string | null;
    startTime: string;
    endTime: string;
    notes: string | null;
    active: boolean;
  }>(
    `SELECT s.user_id AS "userId", s.label_id AS "labelId", l.tier_id AS "labelTierId",
            s.start_time AS "startTime", s.end_time AS "endTime", s.notes,
            (u.deactivated_at IS NULL) AS active
       FROM shifts s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN labels l ON l.id = s.label_id
      WHERE s.schedule_id = $1 AND s.deleted_at IS NULL
      ORDER BY s.start_time`,
    [sourceId],
  );
  let copied = 0;
  let skipped = 0;
  for (const shift of shifts) {
    const day = addDays(localDate(shift.startTime, timezone), offset);
    if (!shift.active || day < target.startDate || day > target.endDate) {
      skipped++;
      continue;
    }
    const moved = moveShiftToDate(shift.startTime, shift.endTime, day, timezone);
    const { rows: overlap } = await client.query(
      `SELECT 1 FROM shifts WHERE user_id = $1 AND deleted_at IS NULL
          AND start_time < $3 AND end_time > $2 LIMIT 1`,
      [shift.userId, moved.startTime, moved.endTime],
    );
    if (overlap.length) {
      skipped++;
      continue;
    }
    // Tier-specific labels from another tier don't apply here.
    const labelId = shift.labelTierId && shift.labelTierId !== targetTierId ? null : shift.labelId;
    await client.query(
      `INSERT INTO shifts (schedule_id, user_id, label_id, start_time, end_time, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [targetId, shift.userId, labelId, moved.startTime, moved.endTime, shift.notes, actor.id],
    );
    copied++;
  }
  return { copied, skipped };
}
