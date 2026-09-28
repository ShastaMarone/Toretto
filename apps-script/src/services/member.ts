import { addDays, dayRangeToUtc } from '@shared/time';
import type { ShiftView, TeamSchedule } from '@shared/types';
import type { AuthUser } from '../../../server/src/auth/types';
import { shiftsConfirmedTemplate } from '../../../server/src/email/templates';
import { badRequest, notFound } from '../../../server/src/errors';
import {
  audit,
  byName,
  getSettings,
  ms,
  personRow,
  publishedShifts,
  shiftView,
  tables,
  timeOffEntries,
  zoneFor,
  type Ctx,
} from '../core';
import { notifyAdmins } from './mail';

export function checkRange(from: string, to: string): void {
  if (to < from) throw badRequest('`to` must be on or after `from`');
  if (Date.parse(to) - Date.parse(from) > 100 * 86_400_000) {
    throw badRequest('Date range is too long');
  }
}

/** Record confirmations and tell the admins who asked to hear about them. */
function afterConfirm(ctx: Ctx, user: AuthUser, shifts: ShiftView[]): void {
  if (!shifts.length) return;
  audit(
    ctx,
    user.id,
    shifts.length === 1 ? 'shift.confirmed' : 'shift.confirmed_all',
    { type: 'shift', id: shifts.length === 1 ? shifts[0]!.id : null },
    shifts.length === 1
      ? { startTime: shifts[0]!.startTime, endTime: shifts[0]!.endTime }
      : { count: shifts.length, shiftIds: shifts.map((s) => s.id) },
  );
  notifyAdmins(ctx, {
    topic: 'confirmations',
    exceptUserId: user.id,
    kind: 'shifts_confirmed',
    shiftIds: shifts.map((s) => s.id),
    render: (email, admin) =>
      shiftsConfirmedTemplate(email, {
        recipientName: admin.name,
        personName: user.name,
        tz: admin.tz,
        timeFormat: admin.timeFormat,
        shifts: shifts.map((s) => ({
          id: s.id,
          startTime: s.startTime,
          endTime: s.endTime,
          labelName: s.label?.name ?? null,
          color: s.label?.color ?? s.tier?.color ?? null,
          notes: s.notes,
          needsConfirmation: false,
        })),
      }),
  });
}

/** The signed-in person's published shifts on these days of their calendar. */
export function myShifts(ctx: Ctx, user: AuthUser, from: string, to: string): ShiftView[] {
  checkRange(from, to);
  const tz = zoneFor(user, getSettings(ctx.db));
  return publishedShifts(ctx.db, dayRangeToUtc(from, to, tz), user.id);
}

export function confirmShift(ctx: Ctx, user: AuthUser, id: string): ShiftView {
  const t = tables(ctx.db);
  const shift = t.shifts.get(id);
  // Someone else's (or an unpublished) shift is reported as not found.
  if (!shift || !shift.publishedAt || shift.publishedUserId !== user.id) throw notFound('Shift');
  const confirming = shift.status === 'pending';
  if (confirming) t.shifts.update(id, { status: 'confirmed', confirmedAt: ctx.now });
  const view = shiftView(ctx.db, shift);
  if (!view) throw notFound('Shift');
  if (confirming) afterConfirm(ctx, user, [view]);
  return view;
}

/** Confirm the given shifts (e.g. from an email), or every upcoming one. */
export function confirmShifts(
  ctx: Ctx,
  user: AuthUser,
  shiftIds?: string[],
): { confirmed: number } {
  const t = tables(ctx.db);
  const wanted = shiftIds ? new Set(shiftIds) : null;
  const now = ms(ctx.now);
  const due = t.shifts
    .where(
      (s) =>
        s.publishedUserId === user.id &&
        s.publishedAt !== null &&
        s.status === 'pending' &&
        !s.deletedAt &&
        ms(s.publishedEndTime!) > now &&
        (!wanted || wanted.has(s.id)),
    )
    .sort((a, b) => ms(a.publishedStartTime!) - ms(b.publishedStartTime!));
  for (const s of due) t.shifts.update(s.id, { status: 'confirmed', confirmedAt: ctx.now });
  const views = due.map((s) => shiftView(ctx.db, s)).filter((v): v is ShiftView => v !== null);
  afterConfirm(ctx, user, views);
  return { confirmed: views.length };
}

/** Everyone's published shifts (every tier and schedule) on these days of the viewer's calendar. */
export function teamSchedule(
  ctx: Ctx,
  viewer: AuthUser,
  startDate: string,
  endDate: string,
): TeamSchedule {
  checkRange(startDate, endDate);
  const t = tables(ctx.db);
  const tz = zoneFor(viewer, getSettings(ctx.db));
  const shifts = publishedShifts(ctx.db, dayRangeToUtc(startDate, endDate, tz));
  // Everyone in a tier, plus anyone else with a shift then.
  const working = new Set(shifts.map((s) => s.userId));
  const people = t.users
    .where((u) => (!u.deactivatedAt && u.tierId !== null) || working.has(u.id))
    .sort(byName)
    .map(personRow);
  // A day either side: part-day time off near midnight can fall on another
  // day in the viewer's zone than on the organization's calendar.
  const timeOff = timeOffEntries(
    ctx.db,
    new Set(people.map((p) => p.id)),
    addDays(startDate, -1),
    addDays(endDate, 1),
    ['approved'],
  ).map((entry) =>
    // Coworkers see that someone is off, not why.
    viewer.role === 'admin' || entry.userId === viewer.id
      ? entry
      : { ...entry, typeName: null, typeColor: null },
  );
  const schedules = t.schedules
    .all()
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || byName(a, b))
    .map((s) => ({ id: s.id, name: s.name }));
  return { people, shifts, timeOff, schedules };
}
