import { formatShiftWhen } from '@shared/time';
import type { BuilderShift, RepeatResult } from '@shared/types';
import type { AuthUser } from '../../../server/src/auth/types';
import { badRequest, conflict, notFound } from '../../../server/src/errors';
import { audit, getSettings, iso, ms, tables, type Ctx } from '../core';
import { approvedTimeOffBetween } from './timeOff';
import { getBuilderShift, requireSchedule } from './schedules';

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

/** Check they can be scheduled and can have the label. */
function checkPersonAndLabel(
  ctx: Ctx,
  input: ShiftInput,
  opts: { checkUser: boolean; checkLabel: boolean },
): { name: string } {
  const t = tables(ctx.db);
  const user = t.users.get(input.userId);
  if (!user) throw notFound('Person');
  if (opts.checkUser && user.deactivatedAt) {
    throw badRequest(`${user.name} is deactivated and can't be scheduled`, {
      userId: 'Deactivated',
    });
  }
  if (input.labelId && opts.checkLabel) {
    const label = t.labels.get(input.labelId);
    if (!label) throw notFound('Label');
    // Tier-specific labels are only for people in that tier.
    if (label.tierId && label.tierId !== user.tierId) {
      const tierName = t.tiers.get(label.tierId)?.name ?? null;
      throw badRequest(
        `${label.name} is a ${tierName} label, and ${user.name} isn't in ${tierName}`,
        { labelId: 'Wrong tier' },
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
function findOverlap(
  ctx: Ctx,
  input: ShiftInput,
  opts: { scheduleId?: string; excludeShiftId?: string },
): Overlap | undefined {
  const t = tables(ctx.db);
  const [start, end] = [ms(input.startTime), ms(input.endTime)];
  const hit = t.shifts
    .where(
      (s) =>
        s.userId === input.userId &&
        !s.deletedAt &&
        s.id !== opts.excludeShiftId &&
        ms(s.startTime) < end &&
        ms(s.endTime) > start,
    )
    .sort((a, b) => ms(a.startTime) - ms(b.startTime))[0];
  if (!hit) return undefined;
  return {
    id: hit.id,
    startTime: hit.startTime,
    endTime: hit.endTime,
    scheduleName: t.schedules.get(hit.scheduleId)?.name ?? '',
    otherSchedule: hit.scheduleId !== (opts.scheduleId ?? null),
  };
}

function validateShift(
  ctx: Ctx,
  input: ShiftInput,
  opts: { scheduleId?: string; excludeShiftId?: string; checkUser: boolean; checkLabel: boolean },
): void {
  checkTimes(input);
  const user = checkPersonAndLabel(ctx, input, opts);
  const overlap = findOverlap(ctx, input, opts);
  if (overlap) {
    const { timezone, timeFormat } = getSettings(ctx.db);
    const where = overlap.otherSchedule ? ` on ${overlap.scheduleName}` : '';
    throw conflict(
      `${user.name} already has a shift${where} ${formatShiftWhen(overlap.startTime, overlap.endTime, timezone, timeFormat)} that overlaps this one`,
      'SHIFT_OVERLAP',
      { shiftId: overlap.id },
    );
  }
}

const normalize = <T extends { startTime: string; endTime: string }>(input: T): T => ({
  ...input,
  startTime: iso(input.startTime),
  endTime: iso(input.endTime),
});

export function createShift(
  ctx: Ctx,
  actor: AuthUser,
  scheduleId: string,
  raw: ShiftInput,
): BuilderShift {
  requireSchedule(ctx, scheduleId);
  const input = normalize(raw);
  validateShift(ctx, input, { scheduleId, checkUser: true, checkLabel: true });
  const row = tables(ctx.db).shifts.insert({ scheduleId, ...input, createdBy: actor.id });
  return getBuilderShift(ctx, row.id);
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
export function createShifts(
  ctx: Ctx,
  actor: AuthUser,
  scheduleId: string,
  input: RepeatInput,
): RepeatResult {
  requireSchedule(ctx, scheduleId);
  const times = input.shifts.map(normalize).sort((a, b) => ms(a.startTime) - ms(b.startTime));
  times.forEach(checkTimes);
  checkPersonAndLabel(ctx, { ...input, ...times[0]! }, { checkUser: true, checkLabel: true });
  const timeOff = approvedTimeOffBetween(
    ctx,
    [input.userId],
    times[0]!.startTime,
    new Date(Math.max(...times.map((t) => ms(t.endTime)))).toISOString(),
  );
  const result: RepeatResult = { created: 0, skipped: [] };
  const t = tables(ctx.db);
  for (const time of times) {
    const off = timeOff.find((o) => ms(o.from) < ms(time.endTime) && ms(o.to) > ms(time.startTime));
    if (off) {
      result.skipped.push({ ...time, reason: 'time_off', detail: off.typeName });
      continue;
    }
    // Earlier days of this repeat count too.
    const overlap = findOverlap(ctx, { ...input, ...time }, { scheduleId });
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
    t.shifts.insert({
      scheduleId,
      userId: input.userId,
      labelId: input.labelId,
      startTime: time.startTime,
      endTime: time.endTime,
      notes: input.notes,
      createdBy: actor.id,
    });
    result.created++;
  }
  return result;
}

export function updateShift(ctx: Ctx, shiftId: string, patch: Partial<ShiftInput>): BuilderShift {
  const t = tables(ctx.db);
  const current = t.shifts.get(shiftId);
  if (!current) throw notFound('Shift');
  if (current.deletedAt) {
    throw conflict('This shift was deleted. Restore it before editing.', 'SHIFT_DELETED');
  }
  const next: ShiftInput = {
    userId: patch.userId ?? current.userId,
    labelId: patch.labelId !== undefined ? patch.labelId : current.labelId,
    startTime: patch.startTime ? iso(patch.startTime) : current.startTime,
    endTime: patch.endTime ? iso(patch.endTime) : current.endTime,
    notes: patch.notes !== undefined ? patch.notes : current.notes,
  };
  validateShift(ctx, next, {
    scheduleId: current.scheduleId,
    excludeShiftId: shiftId,
    checkUser: next.userId !== current.userId,
    // A tier label has to fit whoever the shift now belongs to.
    checkLabel: next.labelId !== current.labelId || next.userId !== current.userId,
  });
  t.shifts.update(shiftId, next);
  return getBuilderShift(ctx, shiftId);
}

/**
 * Delete a shift. Never-published shifts disappear immediately; published ones
 * are only marked, so the team keeps seeing them until the change is published.
 */
export function deleteShift(ctx: Ctx, shiftId: string): { pendingRemoval: boolean } {
  const t = tables(ctx.db);
  const shift = t.shifts.get(shiftId);
  if (!shift) throw notFound('Shift');
  if (!shift.publishedAt) {
    removeShift(ctx, shiftId);
    return { pendingRemoval: false };
  }
  if (!shift.deletedAt) t.shifts.update(shiftId, { deletedAt: ctx.now });
  return { pendingRemoval: true };
}

/** Take someone off every shift (or those starting in a range): unpublished ones vanish, published ones go at the next publish. */
export function removeAllShiftsFor(
  ctx: Ctx,
  userId: string,
  range?: { from: string; to: string },
): { removed: number; pendingRemoval: number } {
  const t = tables(ctx.db);
  if (!t.users.get(userId)) throw notFound('Person');
  const inRange = (startTime: string) =>
    !range || (ms(startTime) >= ms(range.from) && ms(startTime) < ms(range.to));
  let removed = 0;
  let pendingRemoval = 0;
  for (const s of t.shifts.where(
    (s) => s.userId === userId && !s.deletedAt && inRange(s.startTime),
  )) {
    if (deleteShift(ctx, s.id).pendingRemoval) pendingRemoval++;
    else removed++;
  }
  audit(
    ctx,
    ctx.user!.id,
    'user.shifts_removed',
    { type: 'user', id: userId },
    { removed, pendingRemoval },
  );
  return { removed, pendingRemoval };
}

/** Delete a shift row and what hangs off it (its swaps; an open shift's link to it). */
export function removeShift(ctx: Ctx, shiftId: string): void {
  const t = tables(ctx.db);
  for (const w of t.swaps.where((w) => w.shiftId === shiftId || w.returnShiftId === shiftId)) {
    t.swaps.delete(w.id);
  }
  for (const o of t.openShifts.where((o) => o.shiftId === shiftId)) {
    t.openShifts.update(o.id, { shiftId: null });
  }
  t.shifts.delete(shiftId);
}

/** Undo a pending removal of a published shift. */
export function restoreShift(ctx: Ctx, shiftId: string): BuilderShift {
  const t = tables(ctx.db);
  const current = t.shifts.get(shiftId);
  if (!current) throw notFound('Shift');
  if (current.deletedAt) {
    validateShift(ctx, current, {
      scheduleId: current.scheduleId,
      excludeShiftId: shiftId,
      checkUser: false,
      checkLabel: false,
    });
    t.shifts.update(shiftId, { deletedAt: null });
  }
  return getBuilderShift(ctx, shiftId);
}
