import type { ShiftSwap, SwapOption, SwapShift, SwapStatus } from '@shared/types';
import type { AuthUser } from '../../../server/src/auth/types';
import {
  swapAcceptedTemplate,
  swapCancelledTemplate,
  swapDeclinedTemplate,
  swapRequestedTemplate,
  swapReviewedTemplate,
  type EmailShift,
} from '../../../server/src/email/templates';
import { badRequest, conflict, notFound } from '../../../server/src/errors';
import { audit, byName, ms, tables, type Ctx } from '../core';
import type { ShiftRow, SwapRow } from '../db/schema';
import { busyBetween, busyReason } from './availability';
import { notifyAdmins, notifyPerson, reader } from './mail';
import { hasUnpublishedChange } from './schedules';

/** How far ahead a coworker's shifts are offered for a trade. */
const TRADE_DAYS = 60;
const OPEN: SwapStatus[] = ['pending', 'accepted'];
const isOpen = (w: SwapRow) => OPEN.includes(w.status);

/** A shift as published, for a swap: label color, else its owner's tier color. */
function swapShift(ctx: Ctx, s: ShiftRow): SwapShift {
  const t = tables(ctx.db);
  const label = t.labels.get(s.publishedLabelId);
  const owner = t.users.get(s.publishedUserId);
  return {
    id: s.id,
    startTime: s.publishedStartTime!,
    endTime: s.publishedEndTime!,
    labelName: label?.name ?? null,
    color: label?.color ?? t.tiers.get(owner?.tierId)?.color ?? null,
    scheduleName: t.schedules.get(s.scheduleId)?.name ?? '',
  };
}

function toSwap(ctx: Ctx, w: SwapRow): ShiftSwap {
  const t = tables(ctx.db);
  const shift = t.shifts.get(w.shiftId)!;
  const back = t.shifts.get(w.returnShiftId);
  return {
    id: w.id,
    status: w.status,
    requester: { id: w.requesterId, name: t.users.get(w.requesterId)?.name ?? '' },
    recipient: { id: w.recipientId, name: t.users.get(w.recipientId)?.name ?? '' },
    shift: swapShift(ctx, shift),
    returnShift: back ? swapShift(ctx, back) : null,
    note: w.note,
    reviewNote: w.reviewNote,
    reviewedByName: t.users.get(w.reviewedBy)?.name ?? null,
    createdAt: w.createdAt,
    respondedAt: w.respondedAt,
    reviewedAt: w.reviewedAt,
  };
}

/** Its shifts are still the published versions it's about, with the same owners. */
function current(ctx: Ctx, w: SwapRow): boolean {
  const t = tables(ctx.db);
  const same = (id: string | null, ownerId: string, version: string | null) => {
    const s = t.shifts.get(id);
    return (
      !!s &&
      s.publishedAt !== null &&
      s.publishedUserId === ownerId &&
      (version === null || s.publishedAt === version)
    );
  };
  return (
    same(w.shiftId, w.requesterId, w.shiftVersion) &&
    (w.returnShiftId === null || same(w.returnShiftId, w.recipientId, w.returnVersion))
  );
}

/**
 * Open swaps lapse: 'expired' once one of their shifts starts, 'changed' once
 * one is republished with a different person, time or label (its published_at
 * moves on).
 */
export function settleSwaps(ctx: Ctx): void {
  const t = tables(ctx.db);
  const now = ms(ctx.now);
  for (const w of t.swaps.where(isOpen)) {
    const started = [w.shiftId, w.returnShiftId].some((id) => {
      const s = t.shifts.get(id);
      return !!s && s.publishedStartTime !== null && ms(s.publishedStartTime) <= now;
    });
    if (started) t.swaps.update(w.id, { status: 'expired' });
    else if (!current(ctx, w)) t.swaps.update(w.id, { status: 'changed' });
  }
}

export function getSwap(ctx: Ctx, id: string): ShiftSwap {
  const w = tables(ctx.db).swaps.get(id);
  if (!w) throw notFound('Swap');
  return toSwap(ctx, w);
}

/** Newest first. Reads settle lapsed swaps in what they return; the hourly job saves them. */
function settledView(ctx: Ctx, rows: SwapRow[]): SwapRow[] {
  settleSwaps(ctx);
  return rows.map((w) => tables(ctx.db).swaps.get(w.id)!).filter(Boolean);
}

/** Swaps someone offered or was asked to take: open ones, and the last month's others. */
export function listMySwaps(ctx: Ctx, userId: string): ShiftSwap[] {
  const monthAgo = ms(ctx.now) - 30 * 86_400_000;
  const mine = tables(ctx.db).swaps.where(
    (w) => w.requesterId === userId || w.recipientId === userId,
  );
  return settledView(ctx, mine)
    .filter((w) => isOpen(w) || ms(w.updatedAt) > monthAgo)
    .sort((a, b) => ms(b.createdAt) - ms(a.createdAt))
    .slice(0, 50)
    .map((w) => toSwap(ctx, w));
}

/** For admins: waiting for approval first, then waiting for the coworker, then the rest. */
export function listSwaps(ctx: Ctx): ShiftSwap[] {
  const rank = (w: SwapRow) => (w.status === 'accepted' ? 0 : w.status === 'pending' ? 1 : 2);
  return settledView(ctx, tables(ctx.db).swaps.all())
    .sort((a, b) => rank(a) - rank(b) || ms(b.createdAt) - ms(a.createdAt))
    .slice(0, 200)
    .map((w) => toSwap(ctx, w));
}

interface PublishedShift {
  id: string;
  userId: string;
  startTime: string;
  endTime: string;
  labelName: string | null;
  color: string | null;
  notes: string | null;
  version: string;
  /** Removed in the builder, but not published yet. */
  deleted: boolean;
  /** The admin's working copy differs from what's published. */
  changed: boolean;
}

function published(ctx: Ctx, id: string | null): PublishedShift | undefined {
  const s = tables(ctx.db).shifts.get(id);
  if (!s || !s.publishedAt) return undefined;
  const view = swapShift(ctx, s);
  return {
    id: s.id,
    userId: s.publishedUserId!,
    startTime: view.startTime,
    endTime: view.endTime,
    labelName: view.labelName,
    color: view.color,
    notes: s.publishedNotes,
    version: s.publishedAt,
    deleted: s.deletedAt !== null,
    changed: hasUnpublishedChange(s) && s.deletedAt === null,
  };
}

/**
 * Someone's published shift that hasn't started; "not found" otherwise. (An
 * unpublished removal isn't given away: approving waits for it instead.)
 */
function upcoming(ctx: Ctx, shift: PublishedShift | undefined, ownerId: string): PublishedShift {
  if (!shift || shift.userId !== ownerId) throw notFound('Shift');
  if (ms(shift.startTime) <= ms(ctx.now)) throw badRequest('That shift has already started');
  return shift;
}

function assertNotInOpenSwap(ctx: Ctx, shiftIds: string[]): void {
  const clash = tables(ctx.db).swaps.find(
    (w) =>
      isOpen(w) &&
      (shiftIds.includes(w.shiftId) ||
        (w.returnShiftId !== null && shiftIds.includes(w.returnShiftId))),
  );
  if (clash) throw conflict('One of these shifts is already part of a swap', 'SWAP_EXISTS');
}

interface Person {
  id: string;
  name: string;
  email: string;
  tierId: string | null;
  active: boolean;
  /** Has joined (opened the app), so they can answer. */
  joined: boolean;
  timezone: string | null;
  timeFormat: '12h' | '24h' | null;
  deactivatedAt: string | null;
}

function person(ctx: Ctx, id: string): Person | undefined {
  const u = tables(ctx.db).users.get(id);
  if (!u) return undefined;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    tierId: u.tierId,
    active: !u.deactivatedAt,
    joined: u.emailVerifiedAt !== null,
    timezone: u.timezone,
    timeFormat: u.timeFormat,
    deactivatedAt: u.deactivatedAt,
  };
}

/**
 * Both people can work their new shift: the coworker the offered one, and in
 * a trade the requester the coworker's (leaving out the shifts changing
 * hands). Team members only hear about published shifts; admins approving
 * also count drafts.
 */
function assertBothFree(
  ctx: Ctx,
  requester: Person,
  recipient: Person,
  shift: PublishedShift,
  returnShift: PublishedShift | null,
  opts: { admin: boolean },
): void {
  const times = [shift, ...(returnShift ? [returnShift] : [])];
  const from = new Date(Math.min(...times.map((s) => ms(s.startTime)))).toISOString();
  const to = new Date(Math.max(...times.map((s) => ms(s.endTime)))).toISOString();
  const busy = busyBetween(ctx, [requester.id, recipient.id], from, to, { drafts: opts.admin });
  const ignore = times.map((s) => s.id);
  const theirs = busyReason(busy, recipient.id, shift.startTime, shift.endTime, ignore);
  if (theirs) {
    throw conflict(
      `${recipient.name} can't take it: ${theirs === 'Working then' ? 'they have another shift then' : "they're off then"}`,
      'SWAP_BUSY',
    );
  }
  const yours = returnShift
    ? busyReason(busy, requester.id, returnShift.startTime, returnShift.endTime, ignore)
    : null;
  if (yours) {
    throw conflict(
      `${requester.name} can't take ${recipient.name}'s shift: ${yours === 'Working then' ? 'they have another shift then' : "they're off then"}`,
      'SWAP_BUSY',
    );
  }
}

function assertSameTier(requester: Person, recipient: Person): void {
  if (!requester.tierId || requester.tierId !== recipient.tierId) {
    throw badRequest('Shifts can only be swapped with someone in the same tier', {
      recipientId: 'Not in your tier',
    });
  }
  if (!recipient.active) throw badRequest(`${recipient.name} is deactivated`);
  if (!recipient.joined) throw badRequest(`${recipient.name} hasn't joined yet`);
}

const emailShift = (s: {
  id: string;
  startTime: string;
  endTime: string;
  labelName: string | null;
  color: string | null;
  notes?: string | null;
}): EmailShift => ({
  id: s.id,
  startTime: s.startTime,
  endTime: s.endTime,
  labelName: s.labelName,
  color: s.color,
  notes: s.notes ?? null,
  needsConfirmation: false,
});

/** Coworkers in your tier who could take one of your shifts, and their shifts you could take back. */
export function swapOptions(ctx: Ctx, user: AuthUser, shiftId: string): SwapOption[] {
  const shift = upcoming(ctx, published(ctx, shiftId), user.id);
  if (!user.tierId) return [];
  const t = tables(ctx.db);
  const people = t.users
    .where(
      (u) =>
        u.tierId === user.tierId &&
        u.id !== user.id &&
        !u.deactivatedAt &&
        u.emailVerifiedAt !== null,
    )
    .sort(byName);
  if (!people.length) return [];
  const ids = new Set(people.map((p) => p.id));
  const now = ms(ctx.now);
  const horizon = now + TRADE_DAYS * 86_400_000;
  const inSwap = new Set(
    t.swaps
      .where(isOpen)
      .flatMap((w) => [w.shiftId, ...(w.returnShiftId ? [w.returnShiftId] : [])]),
  );
  const theirShifts = t.shifts
    .where(
      (s) =>
        s.publishedAt !== null &&
        ids.has(s.publishedUserId ?? '') &&
        ms(s.publishedStartTime!) > now &&
        ms(s.publishedStartTime!) < horizon &&
        !inSwap.has(s.id),
    )
    .sort((a, b) => ms(a.publishedStartTime!) - ms(b.publishedStartTime!));
  // What the team can see: published shifts and time off, never drafts.
  const busy = busyBetween(
    ctx,
    [user.id, ...ids],
    ctx.now,
    new Date(Math.max(horizon, ms(shift.endTime))).toISOString(),
    { drafts: false },
  );
  return people.map((p) => ({
    id: p.id,
    name: p.name,
    busy: busyReason(busy, p.id, shift.startTime, shift.endTime),
    shifts: theirShifts
      .filter(
        (s) =>
          s.publishedUserId === p.id &&
          !busyReason(busy, user.id, s.publishedStartTime!, s.publishedEndTime!, [shift.id]) &&
          !busyReason(busy, p.id, shift.startTime, shift.endTime, [s.id]),
      )
      .map((s) => swapShift(ctx, s)),
  }));
}

export function requestSwap(
  ctx: Ctx,
  user: AuthUser,
  input: {
    shiftId: string;
    recipientId: string;
    returnShiftId: string | null;
    note: string | null;
  },
): ShiftSwap {
  settleSwaps(ctx);
  const ids = [input.shiftId, ...(input.returnShiftId ? [input.returnShiftId] : [])];
  const shift = upcoming(ctx, published(ctx, input.shiftId), user.id);
  const requester = person(ctx, user.id)!;
  const recipient = person(ctx, input.recipientId);
  if (!recipient || recipient.id === user.id) throw notFound('Person');
  assertSameTier(requester, recipient);
  const returnShift = input.returnShiftId
    ? upcoming(ctx, published(ctx, input.returnShiftId), recipient.id)
    : null;
  assertNotInOpenSwap(ctx, ids);
  assertBothFree(ctx, requester, recipient, shift, returnShift, { admin: false });
  const row = tables(ctx.db).swaps.insert({
    shiftId: shift.id,
    requesterId: user.id,
    recipientId: recipient.id,
    returnShiftId: returnShift?.id ?? null,
    note: input.note,
    shiftVersion: shift.version,
    returnVersion: returnShift?.version ?? null,
  });
  notifyPerson(ctx, reader(recipient), {
    kind: 'swap_requested',
    shiftIds: ids,
    render: (email, prefs) =>
      swapRequestedTemplate(email, {
        recipientName: recipient.name,
        requesterName: requester.name,
        shift: emailShift(shift),
        returnShift: returnShift ? emailShift(returnShift) : null,
        note: input.note,
        ...prefs,
      }),
  });
  audit(
    ctx,
    user.id,
    'swap.requested',
    { type: 'swap', id: row.id },
    {
      recipientName: recipient.name,
      startTime: shift.startTime,
      endTime: shift.endTime,
      trade: Boolean(returnShift),
    },
  );
  return getSwap(ctx, row.id);
}

const LAPSED: Partial<Record<SwapStatus, string>> = {
  expired: 'This swap expired: the shift has already started',
  changed: 'The schedule has changed since, so this swap no longer applies',
};

function assertStatus(status: SwapStatus, allowed: SwapStatus[]): void {
  if (!allowed.includes(status)) {
    throw conflict(LAPSED[status] ?? `This swap is already ${status}`, 'INVALID_STATUS');
  }
}

/** The swap (settled) and its two people. */
function loadSwap(ctx: Ctx, id: string) {
  settleSwaps(ctx);
  const swap = tables(ctx.db).swaps.get(id);
  if (!swap) throw notFound('Swap');
  const shiftIds = [swap.shiftId, ...(swap.returnShiftId ? [swap.returnShiftId] : [])];
  return {
    swap,
    shiftIds,
    requester: person(ctx, swap.requesterId)!,
    recipient: person(ctx, swap.recipientId)!,
  };
}

/** Its shifts as published now, provided they're still what the swap is about and haven't started. */
function stillCurrent(
  ctx: Ctx,
  swap: SwapRow,
): { shift: PublishedShift; returnShift: PublishedShift | null } {
  const now = ms(ctx.now);
  const pick = (id: string, ownerId: string, version: string | null) => {
    const s = published(ctx, id);
    if (!s || s.userId !== ownerId || (version !== null && s.version !== version)) {
      throw conflict(LAPSED.changed!, 'SWAP_STALE');
    }
    if (ms(s.startTime) <= now) throw conflict(LAPSED.expired!, 'SWAP_STALE');
    return s;
  };
  return {
    shift: pick(swap.shiftId, swap.requesterId, swap.shiftVersion),
    returnShift: swap.returnShiftId
      ? pick(swap.returnShiftId, swap.recipientId, swap.returnVersion)
      : null,
  };
}

/** The coworker says yes (admins are asked to approve) or no. */
export function respondToSwap(
  ctx: Ctx,
  user: AuthUser,
  swapId: string,
  answer: 'accept' | 'decline',
): ShiftSwap {
  const { swap, shiftIds, requester, recipient } = loadSwap(ctx, swapId);
  if (swap.recipientId !== user.id) throw notFound('Swap');
  assertStatus(swap.status, ['pending']);
  const { shift, returnShift } = stillCurrent(ctx, swap);
  if (answer === 'accept') {
    assertBothFree(ctx, requester, recipient, shift, returnShift, { admin: false });
  }
  tables(ctx.db).swaps.update(swapId, {
    status: answer === 'accept' ? 'accepted' : 'declined',
    respondedAt: ctx.now,
  });
  if (answer === 'accept') {
    notifyAdmins(ctx, {
      topic: 'swaps',
      exceptUserId: user.id,
      kind: 'swap_accepted',
      shiftIds,
      render: (email, admin) =>
        swapAcceptedTemplate(email, {
          recipientName: admin.name,
          requesterName: requester.name,
          takerName: recipient.name,
          shift: emailShift(shift),
          returnShift: returnShift ? emailShift(returnShift) : null,
          tz: admin.tz,
          timeFormat: admin.timeFormat,
        }),
    });
  } else {
    notifyPerson(ctx, reader(requester), {
      kind: 'swap_declined',
      shiftIds,
      render: (email, prefs) =>
        swapDeclinedTemplate(email, {
          recipientName: requester.name,
          takerName: recipient.name,
          shift: emailShift(shift),
          returnShift: null,
          ...prefs,
        }),
    });
  }
  audit(
    ctx,
    user.id,
    answer === 'accept' ? 'swap.accepted' : 'swap.declined',
    { type: 'swap', id: swapId },
    { requesterName: requester.name, startTime: shift.startTime, endTime: shift.endTime },
  );
  return getSwap(ctx, swapId);
}

/** The person who offered the shift takes the offer back. */
export function cancelSwap(ctx: Ctx, user: AuthUser, swapId: string): ShiftSwap {
  const { swap, requester, recipient } = loadSwap(ctx, swapId);
  if (swap.requesterId !== user.id) throw notFound('Swap');
  assertStatus(swap.status, ['pending', 'accepted']);
  tables(ctx.db).swaps.update(swapId, { status: 'cancelled' });
  const view = getSwap(ctx, swapId);
  notifyPerson(ctx, reader(recipient), {
    kind: 'swap_cancelled',
    shiftIds: [view.shift.id],
    render: (email, prefs) =>
      swapCancelledTemplate(email, {
        recipientName: recipient.name,
        requesterName: requester.name,
        shift: emailShift(view.shift),
        returnShift: null,
        ...prefs,
      }),
  });
  audit(
    ctx,
    user.id,
    'swap.cancelled',
    { type: 'swap', id: swapId },
    { recipientName: recipient.name, startTime: view.shift.startTime, endTime: view.shift.endTime },
  );
  return view;
}

/**
 * An admin approves (the shifts change hands in the published schedule right
 * away, already confirmed) or declines. Approving needs the coworker to have
 * accepted, the shifts to be as they were then, both people to be free, and
 * no unpublished edits to the shifts.
 */
export function reviewSwap(
  ctx: Ctx,
  admin: AuthUser,
  swapId: string,
  decision: 'approved' | 'denied',
  note: string | null,
): ShiftSwap {
  const { swap, shiftIds, requester, recipient } = loadSwap(ctx, swapId);
  assertStatus(swap.status, decision === 'approved' ? ['accepted'] : ['pending', 'accepted']);
  const t = tables(ctx.db);
  if (decision === 'approved') {
    const { shift, returnShift } = stillCurrent(ctx, swap);
    if ([shift, returnShift].some((s) => s && (s.deleted || s.changed))) {
      throw conflict(
        'One of the shifts has unpublished changes. Publish or discard them first.',
        'SWAP_UNPUBLISHED',
      );
    }
    assertSameTier(requester, recipient);
    if (!requester.active) throw badRequest(`${requester.name} is deactivated`);
    assertBothFree(ctx, requester, recipient, shift, returnShift, { admin: true });
    const move = (id: string, to: string) =>
      t.shifts.update(id, {
        userId: to,
        publishedUserId: to,
        status: 'confirmed',
        confirmedAt: ctx.now,
        reminderSentAt: null,
      });
    move(shift.id, recipient.id);
    if (returnShift) move(returnShift.id, requester.id);
  }
  t.swaps.update(swapId, {
    status: decision,
    reviewedBy: admin.id,
    reviewedAt: ctx.now,
    reviewNote: note,
  });
  const view = getSwap(ctx, swapId);
  for (const [who, role, other] of [
    [requester, 'requester', recipient],
    [recipient, 'recipient', requester],
  ] as const) {
    if (who.id === admin.id) continue;
    notifyPerson(ctx, reader(who), {
      kind: 'swap_reviewed',
      shiftIds,
      render: (email, prefs) =>
        swapReviewedTemplate(email, {
          recipientName: who.name,
          status: decision,
          role,
          otherName: other.name,
          reviewerName: admin.name,
          reviewNote: note,
          shift: emailShift(view.shift),
          returnShift: view.returnShift ? emailShift(view.returnShift) : null,
          ...prefs,
        }),
    });
  }
  audit(
    ctx,
    admin.id,
    `swap.${decision}`,
    { type: 'swap', id: swapId },
    {
      requesterName: requester.name,
      recipientName: recipient.name,
      startTime: view.shift.startTime,
      endTime: view.shift.endTime,
      trade: Boolean(view.returnShift),
    },
  );
  return view;
}
