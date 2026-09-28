import type { TimeOffRequest, TimeOffStatus } from '@shared/types';
import { diffDays, localDate, todayIn } from '@shared/time';
import { isPartialDay, timeOffBounds, type TimeOffSpan } from '@shared/timeOff';
import type { AuthUser } from '../../../server/src/auth/types';
import {
  timeOffCancelledTemplate,
  timeOffRequestedTemplate,
  timeOffReviewedTemplate,
} from '../../../server/src/email/templates';
import { badRequest, conflict, forbidden, notFound } from '../../../server/src/errors';
import { audit, compare, getSettings, ms, tables, timeFormatFor, zoneFor, type Ctx } from '../core';
import type { TimeOffRow } from '../db/schema';
import { emailContext, enqueueEmail, notifyAdmins } from './mail';

/** The instants a request covers: its hours, else whole days of the organization's calendar. */
export function requestBounds(r: TimeOffSpan, tz: string) {
  return timeOffBounds(r, tz);
}

const overlaps = (a: { from: string; to: string }, b: { from: string; to: string }) =>
  ms(a.from) < ms(b.to) && ms(a.to) > ms(b.from);

/** Scheduled shifts (drafts too) during the request: admins see this as a warning. */
function conflictCount(ctx: Ctx, r: TimeOffRow, tz: string): number {
  const span = requestBounds(r, tz);
  return tables(ctx.db).shifts.where(
    (s) =>
      s.userId === r.userId && !s.deletedAt && overlaps({ from: s.startTime, to: s.endTime }, span),
  ).length;
}

export function toRequest(ctx: Ctx, r: TimeOffRow): TimeOffRequest {
  const t = tables(ctx.db);
  const { timezone } = getSettings(ctx.db);
  const user = t.users.get(r.userId);
  const type = t.timeOffTypes.get(r.typeId);
  return {
    id: r.id,
    userId: r.userId,
    userName: user?.name ?? '',
    tierId: user?.tierId ?? null,
    type: {
      id: r.typeId,
      name: type?.name ?? '',
      color: type?.color ?? '#64748b',
      paid: type?.paid ?? false,
    },
    startDate: r.startDate,
    endDate: r.endDate,
    startTime: r.startTime,
    endTime: r.endTime,
    note: r.note,
    status: r.status,
    reviewedAt: r.reviewedAt,
    reviewedByName: t.users.get(r.reviewedBy)?.name ?? null,
    reviewNote: r.reviewNote,
    createdAt: r.createdAt,
    conflicts: conflictCount(ctx, r, timezone),
  };
}

/**
 * The conflict count includes draft and unpublished shifts, which only admins
 * may know about; strip it from anything a team member sees.
 */
export function forMember(request: TimeOffRequest): TimeOffRequest {
  const { conflicts: _hidden, ...visible } = request;
  return visible;
}

export function getTimeOffRequest(ctx: Ctx, id: string): TimeOffRequest {
  const row = tables(ctx.db).timeOff.get(id);
  if (!row) throw notFound('Time-off request');
  return toRequest(ctx, row);
}

export function listTimeOff(
  ctx: Ctx,
  filters: { userId?: string; status?: TimeOffStatus | 'all'; from?: string; to?: string },
): TimeOffRequest[] {
  const status = filters.status && filters.status !== 'all' ? filters.status : null;
  return tables(ctx.db)
    .timeOff.where(
      (r) =>
        (!filters.userId || r.userId === filters.userId) &&
        (!status || r.status === status) &&
        (!filters.from || r.endDate >= filters.from) &&
        (!filters.to || r.startDate <= filters.to),
    )
    .sort((a, b) => compare(b.startDate, a.startDate) || compare(b.createdAt, a.createdAt))
    .slice(0, 500)
    .map((r) => toRequest(ctx, r));
}

function assertNoOverlap(
  ctx: Ctx,
  userId: string,
  bounds: { from: string; to: string },
  excludeId: string | null = null,
): void {
  const { timezone } = getSettings(ctx.db);
  const clash = tables(ctx.db).timeOff.find(
    (r) =>
      r.userId === userId &&
      (r.status === 'pending' || r.status === 'approved') &&
      r.id !== excludeId &&
      overlaps(requestBounds(r, timezone), bounds),
  );
  if (clash) {
    throw conflict('There is already time off requested during this time', 'TIME_OFF_OVERLAP');
  }
}

function assertActiveType(ctx: Ctx, typeId: string): void {
  const type = tables(ctx.db).timeOffTypes.get(typeId);
  if (!type) throw notFound('Time-off type');
  if (type.archivedAt) {
    throw badRequest('That time-off type is no longer available', { typeId: 'Archived' });
  }
}

export interface TimeOffInput {
  typeId: string;
  note: string | null;
  /** Whole days (the first and last)… */
  startDate?: string;
  endDate?: string;
  /** …or the exact hours of part of a day. */
  startTime?: string;
  endTime?: string;
}

const MAX_PARTIAL_HOURS = 24;

/** Check the days or hours asked for, and find the calendar days they fall on. */
function resolveSpan(input: TimeOffInput, tz: string): TimeOffSpan {
  if (input.startTime !== undefined || input.endTime !== undefined) {
    if (input.startDate !== undefined || input.endDate !== undefined) {
      throw badRequest('Give either whole days or a start and end time, not both');
    }
    if (!input.startTime || !input.endTime) {
      throw badRequest('Give both a start and an end time', {
        [input.startTime ? 'endTime' : 'startTime']: 'Required',
      });
    }
    const start = Date.parse(input.startTime);
    const end = Date.parse(input.endTime);
    if (end <= start) throw badRequest('The end must be after the start', { endTime: 'Too early' });
    if (end - start > MAX_PARTIAL_HOURS * 3_600_000) {
      throw badRequest('Part of a day can be up to 24 hours. For longer, choose whole days.', {
        endTime: 'Too long',
      });
    }
    const startTime = new Date(start).toISOString();
    const endTime = new Date(end).toISOString();
    return {
      startDate: localDate(startTime, tz),
      // Its last moment's day: time off that ends at midnight stays on one day.
      endDate: localDate(new Date(end - 1).toISOString(), tz),
      startTime,
      endTime,
    };
  }
  const { startDate, endDate } = input;
  if (!startDate || !endDate) {
    throw badRequest('Choose the first and last day', {
      [startDate ? 'endDate' : 'startDate']: 'Required',
    });
  }
  if (endDate < startDate) {
    throw badRequest('The last day must be on or after the first day', {
      endDate: 'Before start date',
    });
  }
  if (diffDays(startDate, endDate) >= 366) {
    throw badRequest('Time off can be requested for up to one year at a time', {
      endDate: 'Too long',
    });
  }
  return { startDate, endDate, startTime: null, endTime: null };
}

/** The when of a request, for audit entries: hours only for part of a day. */
function spanDetails(span: TimeOffSpan) {
  return {
    startDate: span.startDate,
    endDate: span.endDate,
    ...(isPartialDay(span) ? { startTime: span.startTime, endTime: span.endTime } : {}),
  };
}

/** Someone's time zone and 12/24-hour choice, for emailing them. */
function readerPrefs(ctx: Ctx, userId: string) {
  const settings = getSettings(ctx.db);
  const user = tables(ctx.db).users.get(userId) ?? { timezone: null, timeFormat: null };
  return { settings, tz: zoneFor(user, settings), timeFormat: timeFormatFor(user, settings) };
}

/** A team member asks for time off; admins are emailed. */
export function requestTimeOff(ctx: Ctx, user: AuthUser, input: TimeOffInput): TimeOffRequest {
  const { timezone } = getSettings(ctx.db);
  const span = resolveSpan(input, timezone);
  assertActiveType(ctx, input.typeId);
  assertNoOverlap(ctx, user.id, timeOffBounds(span, timezone));
  const row = tables(ctx.db).timeOff.insert({
    userId: user.id,
    typeId: input.typeId,
    ...span,
    note: input.note,
    status: 'pending',
    createdBy: user.id,
  });
  const request = toRequest(ctx, row);
  notifyAdmins(ctx, {
    topic: 'time_off',
    exceptUserId: user.id,
    kind: 'time_off_requested',
    render: (email, admin) =>
      timeOffRequestedTemplate(email, {
        recipientName: admin.name,
        requesterName: user.name,
        typeName: request.type.name,
        span: request,
        tz: admin.tz,
        timeFormat: admin.timeFormat,
        note: request.note,
        conflicts: request.conflicts ?? 0,
      }),
  });
  audit(
    ctx,
    user.id,
    'time_off.requested',
    { type: 'time_off', id: row.id },
    { typeName: request.type.name, ...spanDetails(request) },
  );
  return request;
}

/** An admin records time off for someone; it's approved immediately. */
export function addTimeOffForPerson(
  ctx: Ctx,
  admin: AuthUser,
  userId: string,
  input: TimeOffInput,
): TimeOffRequest {
  const person = tables(ctx.db).users.get(userId);
  if (!person) throw notFound('Person');
  if (person.deactivatedAt) throw badRequest(`${person.name} is deactivated`);
  const { timezone } = getSettings(ctx.db);
  const span = resolveSpan(input, timezone);
  assertActiveType(ctx, input.typeId);
  assertNoOverlap(ctx, userId, timeOffBounds(span, timezone));
  const row = tables(ctx.db).timeOff.insert({
    userId,
    typeId: input.typeId,
    ...span,
    note: input.note,
    status: 'approved',
    reviewedBy: admin.id,
    reviewedAt: ctx.now,
    createdBy: admin.id,
  });
  const request = toRequest(ctx, row);
  if (person.id !== admin.id) {
    const { tz, timeFormat } = readerPrefs(ctx, person.id);
    enqueueEmail(ctx, {
      userId: person.id,
      to: person.email,
      kind: 'time_off_reviewed',
      email: timeOffReviewedTemplate(emailContext(ctx), {
        recipientName: person.name,
        status: 'approved',
        typeName: request.type.name,
        span: request,
        tz,
        timeFormat,
        reviewerName: admin.name,
        reviewNote: request.note,
        addedByAdmin: true,
      }),
    });
  }
  audit(
    ctx,
    admin.id,
    'time_off.added',
    { type: 'time_off', id: row.id },
    { personName: person.name, typeName: request.type.name, ...spanDetails(request) },
  );
  return request;
}

/** Approve or decline. Admins can also change their mind later. */
export function reviewTimeOff(
  ctx: Ctx,
  admin: AuthUser,
  requestId: string,
  decision: 'approved' | 'denied',
  note: string | null,
): TimeOffRequest {
  const t = tables(ctx.db);
  const current = t.timeOff.get(requestId);
  if (!current) throw notFound('Time-off request');
  const allowedFrom: TimeOffStatus[] =
    decision === 'approved' ? ['pending', 'denied'] : ['pending', 'approved'];
  if (!allowedFrom.includes(current.status)) {
    throw conflict(`This request is already ${current.status}`, 'INVALID_STATUS');
  }
  if (decision === 'approved' && current.status === 'denied') {
    const { timezone } = getSettings(ctx.db);
    assertNoOverlap(ctx, current.userId, timeOffBounds(current, timezone), requestId);
  }
  t.timeOff.update(requestId, {
    status: decision,
    reviewedBy: admin.id,
    reviewedAt: ctx.now,
    reviewNote: note,
  });
  const request = getTimeOffRequest(ctx, requestId);
  const person = t.users.get(request.userId);
  if (person && !person.deactivatedAt && person.id !== admin.id) {
    const { tz, timeFormat } = readerPrefs(ctx, person.id);
    enqueueEmail(ctx, {
      userId: person.id,
      to: person.email,
      kind: 'time_off_reviewed',
      email: timeOffReviewedTemplate(emailContext(ctx), {
        recipientName: person.name,
        status: decision,
        typeName: request.type.name,
        span: request,
        tz,
        timeFormat,
        reviewerName: admin.name,
        reviewNote: note,
      }),
    });
  }
  audit(
    ctx,
    admin.id,
    `time_off.${decision}`,
    { type: 'time_off', id: requestId },
    { personName: request.userName, typeName: request.type.name, ...spanDetails(request) },
  );
  return request;
}

/** A team member withdraws a pending request or cancels upcoming approved time off. */
export function cancelTimeOff(ctx: Ctx, user: AuthUser, requestId: string): TimeOffRequest {
  const t = tables(ctx.db);
  const current = t.timeOff.get(requestId);
  if (!current || current.userId !== user.id) throw notFound('Time-off request');
  const settings = getSettings(ctx.db);
  const over = current.endTime
    ? ms(current.endTime) <= ms(ctx.now)
    : current.endDate < todayIn(zoneFor(user, settings));
  if (current.status === 'approved' && over) {
    throw forbidden("Time off that's already over can't be cancelled", 'TIME_OFF_PAST');
  }
  if (current.status !== 'pending' && current.status !== 'approved') {
    throw conflict(`This request is already ${current.status}`, 'INVALID_STATUS');
  }
  const wasApproved = current.status === 'approved';
  t.timeOff.update(requestId, { status: 'cancelled' });
  const request = getTimeOffRequest(ctx, requestId);
  if (wasApproved) {
    notifyAdmins(ctx, {
      topic: 'time_off',
      exceptUserId: user.id,
      kind: 'time_off_cancelled',
      render: (email, admin) =>
        timeOffCancelledTemplate(email, {
          recipientName: admin.name,
          requesterName: user.name,
          typeName: request.type.name,
          span: request,
          tz: admin.tz,
          timeFormat: admin.timeFormat,
        }),
    });
  }
  audit(
    ctx,
    user.id,
    'time_off.cancelled',
    { type: 'time_off', id: requestId },
    { typeName: request.type.name, ...spanDetails(request), wasApproved },
  );
  return request;
}

/** Approved time off (whole days or hours) overlapping from..to, for these people. */
export function approvedTimeOffBetween(
  ctx: Ctx,
  userIds: string[],
  from: string,
  to: string,
): { userId: string; from: string; to: string; typeName: string }[] {
  const { timezone } = getSettings(ctx.db);
  const ids = new Set(userIds);
  const t = tables(ctx.db);
  return t.timeOff
    .where((r) => ids.has(r.userId) && r.status === 'approved')
    .map((r) => ({
      userId: r.userId,
      ...requestBounds(r, timezone),
      typeName: t.timeOffTypes.get(r.typeId)?.name ?? '',
    }))
    .filter((span) => overlaps(span, { from, to }));
}
