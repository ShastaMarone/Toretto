import { addDays, dayRangeToUtc, diffDays, localDate, moveShiftToDate } from '@shared/time';
import type {
  BuilderShift,
  ChangeCounts,
  ChangeState,
  CopyResult,
  ScheduleRange,
  ScheduleSummary,
} from '@shared/types';
import type { AuthUser } from '../../../server/src/auth/types';
import { badRequest, conflict, notFound } from '../../../server/src/errors';
import {
  audit,
  byName,
  getSettings,
  ms,
  personRow,
  tables,
  timeOffEntries,
  type Ctx,
} from '../core';
import type { ScheduleRow, ShiftRow } from '../db/schema';
import type { Db } from '../db/store';
import { labelList } from './catalog';

/** Longest range the builder loads, publishes or copies at once. */
export const MAX_RANGE_DAYS = 62;

export interface DateRange {
  from: string;
  to: string;
}

/** True when a shift's working copy differs from what the team sees. */
export function hasUnpublishedChange(s: ShiftRow): boolean {
  return (
    s.deletedAt !== null ||
    s.publishedAt === null ||
    s.userId !== s.publishedUserId ||
    s.labelId !== s.publishedLabelId ||
    s.startTime !== s.publishedStartTime ||
    s.endTime !== s.publishedEndTime ||
    s.notes !== s.publishedNotes
  );
}

/** A shift belongs to a range when its working copy or its published version starts in it. */
export function inRange(s: ShiftRow, bounds: { from: string; to: string }): boolean {
  const [from, to] = [ms(bounds.from), ms(bounds.to)];
  const starts = (t: string | null) => t !== null && ms(t) >= from && ms(t) < to;
  return (
    (s.deletedAt === null && starts(s.startTime)) ||
    (s.publishedAt !== null && starts(s.publishedStartTime))
  );
}

/** Validate a range of organization calendar days and return its UTC bounds. */
export function rangeBounds(range: DateRange, tz: string): { from: string; to: string } {
  if (range.to < range.from) throw badRequest('The last day must be on or after the first day');
  if (diffDays(range.from, range.to) >= MAX_RANGE_DAYS) {
    throw badRequest(`Pick at most ${MAX_RANGE_DAYS} days at a time`);
  }
  return dayRangeToUtc(range.from, range.to, tz);
}

function summarize(db: Db, schedule: ScheduleRow, shifts: ShiftRow[]): ScheduleSummary {
  const { timezone } = getSettings(db);
  const changed = shifts.filter(hasUnpublishedChange);
  let first: string | null = null;
  let last: string | null = null;
  for (const s of changed) {
    const times = [s.deletedAt === null ? s.startTime : null, s.publishedStartTime].filter(
      (t): t is string => t !== null,
    );
    if (!times.length) continue;
    const days = times.map((t) => localDate(t, timezone)).sort();
    if (first === null || days[0]! < first) first = days[0]!;
    if (last === null || days.at(-1)! > last) last = days.at(-1)!;
  }
  return {
    id: schedule.id,
    name: schedule.name,
    isDefault: schedule.isDefault,
    publishedAt: schedule.publishedAt,
    publishedByName: tables(db).users.get(schedule.publishedBy)?.name ?? null,
    pendingChanges: changed.length,
    firstChangeDate: first,
    lastChangeDate: last,
    createdAt: schedule.createdAt,
  };
}

export function listSchedules(ctx: Ctx): ScheduleSummary[] {
  const t = tables(ctx.db);
  const bySchedule = new Map<string, ShiftRow[]>();
  for (const s of t.shifts.all()) {
    bySchedule.set(s.scheduleId, [...(bySchedule.get(s.scheduleId) ?? []), s]);
  }
  return t.schedules
    .all()
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || byName(a, b))
    .map((sc) => summarize(ctx.db, sc, bySchedule.get(sc.id) ?? []));
}

export function getScheduleSummary(ctx: Ctx, id: string): ScheduleSummary {
  const t = tables(ctx.db);
  const schedule = t.schedules.get(id);
  if (!schedule) throw notFound('Schedule');
  return summarize(
    ctx.db,
    schedule,
    t.shifts.where((s) => s.scheduleId === id),
  );
}

/** The schedule, or 404. */
export function requireSchedule(ctx: Ctx, id: string): ScheduleRow {
  const schedule = tables(ctx.db).schedules.get(id);
  if (!schedule) throw notFound('Schedule');
  return schedule;
}

/** The default schedule's id, creating it if it's missing. */
export function ensureDefaultSchedule(ctx: Ctx): string {
  const t = tables(ctx.db);
  const found = t.schedules.find((s) => s.isDefault);
  return found ? found.id : t.schedules.insert({ name: 'Main schedule', isDefault: true }).id;
}

export function toBuilderShift(s: ShiftRow): BuilderShift {
  const published = s.publishedAt
    ? {
        userId: s.publishedUserId!,
        labelId: s.publishedLabelId,
        startTime: s.publishedStartTime!,
        endTime: s.publishedEndTime!,
        notes: s.publishedNotes,
      }
    : null;
  let changeState: ChangeState;
  if (s.deletedAt) changeState = 'removed';
  else if (!published) changeState = 'new';
  else if (
    published.userId !== s.userId ||
    published.labelId !== s.labelId ||
    published.startTime !== s.startTime ||
    published.endTime !== s.endTime ||
    published.notes !== s.notes
  )
    changeState = 'updated';
  else changeState = 'unchanged';
  return {
    id: s.id,
    scheduleId: s.scheduleId,
    userId: s.userId,
    labelId: s.labelId,
    startTime: s.startTime,
    endTime: s.endTime,
    notes: s.notes,
    status: s.status,
    confirmedAt: s.confirmedAt,
    changeState,
    published,
  };
}

export function getBuilderShift(ctx: Ctx, id: string): BuilderShift {
  const row = tables(ctx.db).shifts.get(id);
  if (!row) throw notFound('Shift');
  return toBuilderShift(row);
}

export function getScheduleRange(ctx: Ctx, id: string, range: DateRange): ScheduleRange {
  const t = tables(ctx.db);
  const { timezone } = getSettings(ctx.db);
  const bounds = rangeBounds(range, timezone);
  const schedule = getScheduleSummary(ctx, id);
  const all = t.shifts
    .where((s) => s.scheduleId === id && inRange(s, bounds))
    .sort((a, b) => ms(a.startTime) - ms(b.startTime) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(toBuilderShift);
  const [fromMs, toMs] = [ms(bounds.from), ms(bounds.to)];
  const shown = (s: BuilderShift) =>
    s.changeState !== 'removed' && ms(s.startTime) >= fromMs && ms(s.startTime) < toMs;
  const shifts = all.filter(shown);
  const removedShifts = all.filter((s) => !shown(s));
  const involved = new Set(all.flatMap((s) => [s.userId, s.published?.userId ?? s.userId]));
  const people = t.users
    .where((u) => !u.deactivatedAt || involved.has(u.id))
    .sort(byName)
    .map(personRow);
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
    labels: labelList(ctx),
    timeOff: timeOffEntries(ctx.db, new Set(people.map((p) => p.id)), range.from, range.to, [
      'pending',
      'approved',
    ]),
    changes,
  };
}

function assertNameFree(ctx: Ctx, name: string, exceptId?: string): void {
  const lower = name.toLowerCase();
  if (tables(ctx.db).schedules.find((s) => s.id !== exceptId && s.name.toLowerCase() === lower)) {
    throw conflict('There is already a schedule with that name.', 'NAME_TAKEN');
  }
}

export function createSchedule(
  ctx: Ctx,
  actor: AuthUser,
  input: { name: string },
): ScheduleSummary {
  assertNameFree(ctx, input.name);
  const row = tables(ctx.db).schedules.insert({ name: input.name, createdBy: actor.id });
  audit(ctx, actor.id, 'schedule.created', { type: 'schedule', id: row.id }, { title: input.name });
  return getScheduleSummary(ctx, row.id);
}

export function renameSchedule(
  ctx: Ctx,
  actor: AuthUser,
  id: string,
  name: string,
): ScheduleSummary {
  const schedule = requireSchedule(ctx, id);
  assertNameFree(ctx, name, id);
  const previous = schedule.name;
  tables(ctx.db).schedules.update(id, { name });
  audit(ctx, actor.id, 'schedule.renamed', { type: 'schedule', id }, { title: name, previous });
  return getScheduleSummary(ctx, id);
}

/**
 * Copy the shifts in one range of days into the same number of days starting
 * at `targetStart`, as unpublished additions. Each copy keeps its weekday
 * offset, wall-clock times, person, label and note. Copies that would
 * double-book someone, or are for deactivated people, are skipped.
 */
export function copyShifts(
  ctx: Ctx,
  actor: AuthUser,
  scheduleId: string,
  input: { from: string; to: string; targetStart: string },
): CopyResult {
  const t = tables(ctx.db);
  const schedule = requireSchedule(ctx, scheduleId);
  const { timezone } = getSettings(ctx.db);
  const source = rangeBounds(input, timezone);
  const offset = diffDays(input.from, input.targetStart);
  const targetEnd = addDays(input.to, offset);
  if (offset === 0) throw badRequest('Pick a different week to copy into');
  if (input.targetStart <= input.to && targetEnd >= input.from) {
    throw badRequest("The days you copy into can't overlap the days you copy from");
  }
  const [from, to] = [ms(source.from), ms(source.to)];
  const shifts = t.shifts
    .where(
      (s) =>
        s.scheduleId === scheduleId &&
        !s.deletedAt &&
        ms(s.startTime) >= from &&
        ms(s.startTime) < to,
    )
    .sort((a, b) => ms(a.startTime) - ms(b.startTime));
  let copied = 0;
  let skipped = 0;
  for (const shift of shifts) {
    const day = addDays(localDate(shift.startTime, timezone), offset);
    const moved = moveShiftToDate(shift.startTime, shift.endTime, day, timezone);
    const person = t.users.get(shift.userId);
    const overlap = t.shifts.find(
      (s) =>
        s.userId === shift.userId &&
        !s.deletedAt &&
        ms(s.startTime) < ms(moved.endTime) &&
        ms(s.endTime) > ms(moved.startTime),
    );
    if (!person || person.deactivatedAt || overlap) {
      skipped++;
      continue;
    }
    t.shifts.insert({
      scheduleId,
      userId: shift.userId,
      labelId: shift.labelId,
      startTime: moved.startTime,
      endTime: moved.endTime,
      notes: shift.notes,
      createdBy: actor.id,
    });
    copied++;
  }
  audit(
    ctx,
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
}
