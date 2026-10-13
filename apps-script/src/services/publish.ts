import { formatDateRange, formatShiftWhen, localDate } from '@shared/time';
import type { PublishResult } from '@shared/types';
import type { AuthUser } from '../../../server/src/auth/types';
import { scheduleTemplate, type EmailShift } from '../../../server/src/email/templates';
import { badRequest, conflict } from '../../../server/src/errors';
import { audit, getSettings, ms, tables, timeFormatFor, zoneFor, type Ctx } from '../core';
import type { ScheduleRow, ShiftRow } from '../db/schema';
import { emailContext, enqueueEmail, type NotificationKind } from './mail';
import {
  hasUnpublishedChange,
  inRange,
  rangeBounds,
  requireSchedule,
  type DateRange,
} from './schedules';
import { removeShift } from './shifts';

interface Snapshot {
  id: string;
  userId: string;
  labelId: string | null;
  startTime: string;
  endTime: string;
  notes: string | null;
  needsConfirmation: boolean;
}

interface PersonChanges {
  added: Snapshot[];
  updated: { before: Snapshot; after: Snapshot }[];
  removed: Snapshot[];
}

const working = (s: ShiftRow, needsConfirmation: boolean): Snapshot => ({
  id: s.id,
  userId: s.userId,
  labelId: s.labelId,
  startTime: s.startTime,
  endTime: s.endTime,
  notes: s.notes,
  needsConfirmation,
});

const published = (s: ShiftRow): Snapshot => ({
  id: s.id,
  userId: s.publishedUserId!,
  labelId: s.publishedLabelId,
  startTime: s.publishedStartTime!,
  endTime: s.publishedEndTime!,
  notes: s.publishedNotes,
  needsConfirmation: false,
});

/** Which shifts a date range (or none: every date) covers. */
function rangeFilter(ctx: Ctx, range: DateRange | null) {
  if (!range) return { test: (_s: ShiftRow) => true, label: 'all dates' };
  const bounds = rangeBounds(range, getSettings(ctx.db).timezone);
  return {
    test: (s: ShiftRow) => inRange(s, bounds),
    label: formatDateRange(range.from, range.to),
  };
}

/**
 * Queue one email per affected person describing their new, changed and
 * cancelled shifts. Shifts that already ended are left out; people with
 * nothing upcoming get no email.
 */
function notifyPeople(
  ctx: Ctx,
  schedule: ScheduleRow,
  changes: Map<string, PersonChanges>,
  opts: { kind?: NotificationKind } = {},
): number {
  if (changes.size === 0) return 0;
  const t = tables(ctx.db);
  const settings = getSettings(ctx.db);
  const now = ms(ctx.now);
  const upcoming = (s: Snapshot) => ms(s.endTime) > now;
  // Only name the schedule when there's more than one to tell apart.
  const scheduleName = t.schedules.all().length > 1 ? schedule.name : null;
  let queued = 0;
  for (const [userId, c] of changes) {
    const person = t.users.get(userId);
    if (!person || person.deactivatedAt) continue;
    const added = c.added.filter(upcoming);
    // Moving a future shift into the past still changes someone's upcoming week.
    const updated = c.updated.filter((u) => upcoming(u.after) || upcoming(u.before));
    const removed = c.removed.filter(upcoming);
    if (!added.length && !updated.length && !removed.length) continue;
    const tz = zoneFor(person, settings);
    const tierColor = t.tiers.get(person.tierId)?.color ?? null;
    const toEmailShift = (s: Snapshot): EmailShift => {
      const label = t.labels.get(s.labelId);
      return {
        id: s.id,
        startTime: s.startTime,
        endTime: s.endTime,
        labelName: label?.name ?? null,
        color: label?.color ?? tierColor,
        notes: s.notes,
        needsConfirmation: s.needsConfirmation,
      };
    };
    const days = [...added, ...removed, ...updated.flatMap((u) => [u.before, u.after])]
      .map((s) => localDate(s.startTime, tz))
      .sort();
    const kind: NotificationKind =
      opts.kind ??
      (!added.length && !updated.length
        ? 'schedule_cancelled'
        : updated.length || removed.length
          ? 'schedule_updated'
          : 'schedule_published');
    enqueueEmail(ctx, {
      userId: person.id,
      to: person.email,
      kind,
      scheduleId: schedule.id,
      shiftIds: [...added, ...updated.map((u) => u.after), ...removed].map((s) => s.id),
      email: scheduleTemplate(emailContext(ctx), {
        recipientName: person.name,
        tz,
        timeFormat: timeFormatFor(person, settings),
        scheduleName,
        startDate: days[0]!,
        endDate: days[days.length - 1]!,
        added: added.map(toEmailShift),
        updated: updated.map((u) => ({
          before: toEmailShift(u.before),
          after: toEmailShift(u.after),
        })),
        removed: removed.map(toEmailShift),
      }),
    });
    queued++;
  }
  return queued;
}

/**
 * Publish the unpublished changes in a date range (or everywhere): the team
 * sees the new version, and everyone affected gets one email.
 */
export function publishSchedule(
  ctx: Ctx,
  scheduleId: string,
  actor: AuthUser,
  range: DateRange | null,
): PublishResult {
  const t = tables(ctx.db);
  const schedule = requireSchedule(ctx, scheduleId);
  const filter = rangeFilter(ctx, range);
  const rows = t.shifts
    .where((s) => s.scheduleId === scheduleId && filter.test(s))
    .sort((a, b) => ms(a.startTime) - ms(b.startTime));
  const changes = new Map<string, PersonChanges>();
  const forPerson = (userId: string) => {
    let c = changes.get(userId);
    if (!c) changes.set(userId, (c = { added: [], updated: [], removed: [] }));
    return c;
  };
  const result: PublishResult = { added: 0, updated: 0, removed: 0, unchanged: 0, emailsQueued: 0 };
  const toDelete: string[] = [];
  const reset: ShiftRow[] = [];
  const notesOnly: ShiftRow[] = [];

  for (const s of rows) {
    if (s.deletedAt) {
      toDelete.push(s.id);
      if (s.publishedAt) {
        result.removed++;
        forPerson(s.publishedUserId!).removed.push(published(s));
      }
      continue;
    }
    if (!s.publishedAt) {
      result.added++;
      reset.push(s);
      forPerson(s.userId).added.push(working(s, true));
      continue;
    }
    const material =
      s.userId !== s.publishedUserId ||
      s.labelId !== s.publishedLabelId ||
      ms(s.startTime) !== ms(s.publishedStartTime!) ||
      ms(s.endTime) !== ms(s.publishedEndTime!);
    const notesChanged = (s.notes ?? null) !== (s.publishedNotes ?? null);
    if (!material && !notesChanged) {
      result.unchanged++;
      continue;
    }
    result.updated++;
    (material ? reset : notesOnly).push(s);
    if (s.userId !== s.publishedUserId) {
      // Reassigned: it's cancelled for one person and new for another.
      forPerson(s.publishedUserId!).removed.push(published(s));
      forPerson(s.userId).added.push(working(s, true));
    } else {
      forPerson(s.userId).updated.push({
        before: published(s),
        after: working(s, material || s.status === 'pending'),
      });
    }
  }

  for (const id of toDelete) removeShift(ctx, id);
  for (const s of reset) {
    t.shifts.update(s.id, {
      publishedAt: ctx.now,
      publishedUserId: s.userId,
      publishedLabelId: s.labelId,
      publishedStartTime: s.startTime,
      publishedEndTime: s.endTime,
      publishedNotes: s.notes,
      status: 'pending',
      confirmedAt: null,
      reminderSentAt: null,
    });
  }
  for (const s of notesOnly) t.shifts.update(s.id, { publishedNotes: s.notes });
  const changed = result.added + result.updated + result.removed;
  if (changed) t.schedules.update(scheduleId, { publishedAt: ctx.now, publishedBy: actor.id });

  result.emailsQueued = notifyPeople(ctx, schedule, changes);
  if (changed) {
    audit(
      ctx,
      actor.id,
      'schedule.published',
      { type: 'schedule', id: scheduleId },
      {
        title: schedule.name,
        range: filter.label,
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        emails: result.emailsQueued,
      },
    );
  }
  return result;
}

/**
 * Throw away unpublished edits in a date range (or everywhere), restoring
 * the version the team currently sees. Never-published shifts are deleted.
 */
export function discardChanges(
  ctx: Ctx,
  scheduleId: string,
  actor: AuthUser,
  range: DateRange | null,
): { discarded: number } {
  const t = tables(ctx.db);
  const schedule = requireSchedule(ctx, scheduleId);
  const filter = rangeFilter(ctx, range);
  const mine = t.shifts.where((s) => s.scheduleId === scheduleId && filter.test(s));
  const drafts = mine.filter((s) => !s.publishedAt);
  for (const s of drafts) removeShift(ctx, s.id);
  const reverted = mine.filter((s) => s.publishedAt && hasUnpublishedChange(s));
  for (const s of reverted) {
    t.shifts.update(s.id, {
      userId: s.publishedUserId!,
      labelId: s.publishedLabelId,
      startTime: s.publishedStartTime!,
      endTime: s.publishedEndTime!,
      notes: s.publishedNotes,
      deletedAt: null,
    });
  }
  // A restored shift may now collide with one added elsewhere in the meantime.
  const clash = reverted
    .filter((a) =>
      t.shifts.find(
        (b) =>
          b.userId === a.userId &&
          b.id !== a.id &&
          !b.deletedAt &&
          ms(a.startTime) < ms(b.endTime) &&
          ms(a.endTime) > ms(b.startTime),
      ),
    )
    .sort((a, b) => ms(a.startTime) - ms(b.startTime))[0];
  if (clash) {
    const { timezone, timeFormat } = getSettings(ctx.db);
    const name = t.users.get(clash.userId)?.name ?? 'Someone';
    throw conflict(
      `Can't discard: ${name} would be double-booked ${formatShiftWhen(clash.startTime, clash.endTime, timezone, timeFormat)}. Move or remove their other shift first.`,
      'SHIFT_OVERLAP',
    );
  }
  const discarded = drafts.length + reverted.length;
  if (discarded) {
    audit(
      ctx,
      actor.id,
      'schedule.changes_discarded',
      { type: 'schedule', id: scheduleId },
      { title: schedule.name, range: filter.label, discarded },
    );
  }
  return { discarded };
}

/** Delete an extra schedule. Everyone with upcoming published shifts on it is told. */
export function deleteSchedule(
  ctx: Ctx,
  scheduleId: string,
  actor: AuthUser,
): { notified: number } {
  const t = tables(ctx.db);
  const schedule = requireSchedule(ctx, scheduleId);
  if (schedule.isDefault) throw badRequest("The main schedule can't be deleted");
  const shifts = t.shifts.where((s) => s.scheduleId === scheduleId);
  const changes = new Map<string, PersonChanges>();
  for (const s of shifts
    .filter((s) => s.publishedAt)
    .sort((a, b) => ms(a.publishedStartTime!) - ms(b.publishedStartTime!))) {
    const userId = s.publishedUserId!;
    if (!changes.has(userId)) changes.set(userId, { added: [], updated: [], removed: [] });
    changes.get(userId)!.removed.push(published(s));
  }
  const notified = notifyPeople(ctx, schedule, changes, { kind: 'schedule_cancelled' });
  for (const s of shifts) removeShift(ctx, s.id);
  for (const o of t.openShifts.where((o) => o.scheduleId === scheduleId)) t.openShifts.delete(o.id);
  t.schedules.delete(scheduleId);
  audit(
    ctx,
    actor.id,
    'schedule.deleted',
    { type: 'schedule', id: scheduleId },
    { title: schedule.name, notified },
  );
  return { notified };
}
