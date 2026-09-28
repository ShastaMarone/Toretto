import type { OpenShift, OpenShiftStatus } from '@shared/types';
import type { AuthUser } from '../../../server/src/auth/types';
import {
  openShiftCancelledTemplate,
  openShiftClaimedTemplate,
  openShiftPostedTemplate,
  openShiftReviewedTemplate,
  type EmailShift,
} from '../../../server/src/email/templates';
import { badRequest, conflict, notFound } from '../../../server/src/errors';
import { audit, compare, iso, ms, tables, type Ctx } from '../core';
import type { OpenShiftRow } from '../db/schema';
import { busyBetween, busyReason } from './availability';
import { notifyAdmins, notifyPerson, reader } from './mail';

const MAX_HOURS = 24;

function toOpenShift(ctx: Ctx, o: OpenShiftRow): OpenShift {
  const t = tables(ctx.db);
  const tier = t.tiers.get(o.tierId);
  const label = t.labels.get(o.labelId);
  const claimer = t.users.get(o.claimedBy);
  return {
    id: o.id,
    status: o.status,
    scheduleId: o.scheduleId,
    scheduleName: t.schedules.get(o.scheduleId)?.name ?? '',
    tier: { id: o.tierId, name: tier?.name ?? '', color: tier?.color ?? '#64748b' },
    label: label ? { id: label.id, name: label.name, color: label.color } : null,
    startTime: o.startTime,
    endTime: o.endTime,
    notes: o.notes,
    claimedBy: claimer ? { id: claimer.id, name: claimer.name } : null,
    claimedAt: o.claimedAt,
    reviewedByName: t.users.get(o.reviewedBy)?.name ?? null,
    createdAt: o.createdAt,
  };
}

/** Open shifts that started before anyone got them can't be picked up any more. */
export function settleOpenShifts(ctx: Ctx): void {
  const t = tables(ctx.db);
  const now = ms(ctx.now);
  for (const o of t.openShifts.where(
    (o) => (o.status === 'open' || o.status === 'claimed') && ms(o.startTime) <= now,
  )) {
    t.openShifts.update(o.id, { status: 'expired' });
  }
}

export function getOpenShift(ctx: Ctx, id: string): OpenShift {
  const o = tables(ctx.db).openShifts.get(id);
  if (!o) throw notFound('Open shift');
  return toOpenShift(ctx, o);
}

/** For admins: picked up (to approve) first, then open, then the last month's others. */
export function listOpenShifts(ctx: Ctx): OpenShift[] {
  settleOpenShifts(ctx);
  const monthAgo = ms(ctx.now) - 30 * 86_400_000;
  const rank = (o: OpenShiftRow) => (o.status === 'claimed' ? 0 : o.status === 'open' ? 1 : 2);
  return tables(ctx.db)
    .openShifts.where(
      (o) => o.status === 'open' || o.status === 'claimed' || ms(o.updatedAt) > monthAgo,
    )
    .sort((a, b) => rank(a) - rank(b) || ms(a.startTime) - ms(b.startTime))
    .slice(0, 200)
    .map((o) => toOpenShift(ctx, o));
}

/** What someone can pick up in their tier, and what they've picked up that's waiting. */
export function openShiftsFor(ctx: Ctx, user: AuthUser): OpenShift[] {
  settleOpenShifts(ctx);
  if (!user.tierId) return [];
  const now = ms(ctx.now);
  const rows = tables(ctx.db)
    .openShifts.where(
      (o) =>
        o.tierId === user.tierId &&
        ms(o.startTime) > now &&
        ((o.status === 'open' && !o.declinedIds.includes(user.id)) ||
          (o.status === 'claimed' && o.claimedBy === user.id)),
    )
    .sort((a, b) => ms(a.startTime) - ms(b.startTime));
  if (!rows.length) return [];
  // What they can see themselves: published shifts and time off, never drafts.
  const busy = busyBetween(
    ctx,
    [user.id],
    rows[0]!.startTime,
    new Date(Math.max(...rows.map((o) => ms(o.endTime)))).toISOString(),
    { drafts: false },
  );
  return rows.map((o) => ({
    ...toOpenShift(ctx, o),
    busy: o.status === 'open' ? busyReason(busy, user.id, o.startTime, o.endTime) : null,
  }));
}

const emailShift = (o: OpenShift): EmailShift => ({
  id: o.id,
  startTime: o.startTime,
  endTime: o.endTime,
  labelName: o.label?.name ?? null,
  color: o.label?.color ?? o.tier.color,
  notes: o.notes,
  needsConfirmation: false,
});

/** Post a shift for everyone in a tier to pick up; they're emailed right away. */
export function postOpenShift(
  ctx: Ctx,
  admin: AuthUser,
  input: {
    scheduleId: string | null;
    tierId: string;
    labelId: string | null;
    startTime: string;
    endTime: string;
    notes: string | null;
  },
): OpenShift {
  const start = Date.parse(input.startTime);
  const end = Date.parse(input.endTime);
  if (!(end > start)) throw badRequest('It must end after it starts', { endTime: 'Too early' });
  if (end - start > MAX_HOURS * 3_600_000) {
    throw badRequest('An open shift can be up to 24 hours long', { endTime: 'Too long' });
  }
  if (start <= ms(ctx.now)) throw badRequest('Pick a time that hasn’t started yet');
  const t = tables(ctx.db);
  const tier = t.tiers.get(input.tierId);
  if (!tier) throw notFound('Tier');
  if (input.labelId) {
    const label = t.labels.get(input.labelId);
    if (!label) throw notFound('Label');
    if (label.tierId && label.tierId !== input.tierId) {
      throw badRequest(`That label isn't for ${tier.name}`, { labelId: 'Wrong tier' });
    }
  }
  const schedule = input.scheduleId
    ? t.schedules.get(input.scheduleId)
    : t.schedules.find((s) => s.isDefault);
  if (!schedule) throw notFound('Schedule');
  const row = t.openShifts.insert({
    scheduleId: schedule.id,
    tierId: input.tierId,
    labelId: input.labelId,
    startTime: iso(input.startTime),
    endTime: iso(input.endTime),
    notes: input.notes,
    createdBy: admin.id,
  });
  const openShift = toOpenShift(ctx, row);
  const members = t.users
    .where(
      (u) =>
        u.tierId === input.tierId &&
        !u.deactivatedAt &&
        u.emailVerifiedAt !== null &&
        u.id !== admin.id,
    )
    .sort((a, b) => compare(a.email, b.email));
  for (const member of members) {
    notifyPerson(ctx, reader(member), {
      kind: 'open_shift_posted',
      render: (email, prefs) =>
        openShiftPostedTemplate(email, {
          recipientName: member.name,
          shift: emailShift(openShift),
          tierName: openShift.tier.name,
          ...prefs,
        }),
    });
  }
  audit(
    ctx,
    admin.id,
    'open_shift.posted',
    { type: 'open_shift', id: row.id },
    {
      tierName: openShift.tier.name,
      startTime: openShift.startTime,
      endTime: openShift.endTime,
      emails: members.length,
    },
  );
  return openShift;
}

/** The open shift; one that has started counts as expired. */
function load(ctx: Ctx, id: string): OpenShiftRow {
  settleOpenShifts(ctx);
  const o = tables(ctx.db).openShifts.get(id);
  if (!o) throw notFound('Open shift');
  return o;
}

/**
 * Someone is free for it: no other shift or time off then. `name` is null
 * when it's the reader. Team members only hear about published shifts; an
 * admin approving also counts drafts.
 */
function assertFree(
  ctx: Ctx,
  userId: string,
  name: string | null,
  o: OpenShift,
  opts: { admin: boolean },
): void {
  const busy = busyReason(
    busyBetween(ctx, [userId], o.startTime, o.endTime, { drafts: opts.admin }),
    userId,
    o.startTime,
    o.endTime,
  );
  if (busy) {
    const working = busy === 'Working then';
    throw conflict(
      name
        ? `${name} ${working ? 'already has a shift' : 'has time off'} then`
        : `You ${working ? 'already have a shift' : 'have time off'} then`,
      'OPEN_SHIFT_BUSY',
    );
  }
}

const unavailable = (status: OpenShiftStatus) =>
  conflict(
    status === 'claimed'
      ? 'Someone already picked this shift up'
      : status === 'open'
        ? 'Nobody has this shift picked up any more'
        : `This open shift is ${status === 'filled' ? 'taken' : status}`,
    'OPEN_SHIFT_TAKEN',
  );

/** The first person in the tier to pick it up holds it until an admin decides. */
export function claimOpenShift(ctx: Ctx, user: AuthUser, id: string): OpenShift {
  const row = load(ctx, id);
  if (row.tierId !== user.tierId) throw notFound('Open shift');
  if (row.status !== 'open') throw unavailable(row.status);
  if (row.declinedIds.includes(user.id)) {
    throw conflict('An admin already said no to you for this one', 'OPEN_SHIFT_DECLINED');
  }
  const openShift = toOpenShift(ctx, row);
  assertFree(ctx, user.id, null, openShift, { admin: false });
  tables(ctx.db).openShifts.update(id, {
    status: 'claimed',
    claimedBy: user.id,
    claimedAt: ctx.now,
  });
  notifyAdmins(ctx, {
    topic: 'swaps',
    exceptUserId: user.id,
    kind: 'open_shift_claimed',
    render: (email, admin) =>
      openShiftClaimedTemplate(email, {
        recipientName: admin.name,
        claimerName: user.name,
        shift: emailShift(openShift),
        tierName: openShift.tier.name,
        tz: admin.tz,
        timeFormat: admin.timeFormat,
      }),
  });
  audit(
    ctx,
    user.id,
    'open_shift.claimed',
    { type: 'open_shift', id },
    { startTime: openShift.startTime, endTime: openShift.endTime },
  );
  return getOpenShift(ctx, id);
}

/** Change your mind before an admin decides: it's open again. */
export function releaseOpenShift(ctx: Ctx, user: AuthUser, id: string): OpenShift {
  const row = load(ctx, id);
  if (row.claimedBy !== user.id) throw notFound('Open shift');
  if (row.status !== 'claimed') throw unavailable(row.status);
  tables(ctx.db).openShifts.update(id, { status: 'open', claimedBy: null, claimedAt: null });
  const openShift = getOpenShift(ctx, id);
  audit(
    ctx,
    user.id,
    'open_shift.released',
    { type: 'open_shift', id },
    { startTime: openShift.startTime, endTime: openShift.endTime },
  );
  return openShift;
}

/**
 * Approve (it becomes the person's shift, published and confirmed) or
 * decline (it's open again for everyone else).
 */
export function reviewOpenShift(
  ctx: Ctx,
  admin: AuthUser,
  id: string,
  decision: 'approved' | 'denied',
  note: string | null,
): OpenShift {
  const t = tables(ctx.db);
  const row = load(ctx, id);
  if (row.status !== 'claimed' || !row.claimedBy) throw unavailable(row.status);
  const openShift = toOpenShift(ctx, row);
  const claimer = t.users.get(row.claimedBy)!;
  if (decision === 'approved') {
    if (claimer.deactivatedAt || claimer.tierId !== row.tierId) {
      throw conflict(
        `${claimer.name} is no longer in ${openShift.tier.name}`,
        'OPEN_SHIFT_INELIGIBLE',
      );
    }
    if (!t.schedules.get(row.scheduleId)) throw notFound('Schedule');
    assertFree(ctx, claimer.id, claimer.name, openShift, { admin: true });
    const shift = t.shifts.insert({
      scheduleId: row.scheduleId,
      userId: claimer.id,
      labelId: openShift.label?.id ?? null,
      startTime: openShift.startTime,
      endTime: openShift.endTime,
      notes: openShift.notes,
      status: 'confirmed',
      confirmedAt: ctx.now,
      publishedAt: ctx.now,
      publishedUserId: claimer.id,
      publishedLabelId: openShift.label?.id ?? null,
      publishedStartTime: openShift.startTime,
      publishedEndTime: openShift.endTime,
      publishedNotes: openShift.notes,
      createdBy: admin.id,
    });
    t.openShifts.update(id, {
      status: 'filled',
      shiftId: shift.id,
      reviewedBy: admin.id,
      reviewedAt: ctx.now,
    });
  } else {
    t.openShifts.update(id, {
      status: 'open',
      claimedBy: null,
      claimedAt: null,
      declinedIds: [...row.declinedIds, claimer.id],
      reviewedBy: admin.id,
      reviewedAt: ctx.now,
    });
  }
  if (claimer.id !== admin.id) {
    notifyPerson(ctx, reader(claimer), {
      kind: 'open_shift_reviewed',
      render: (email, prefs) =>
        openShiftReviewedTemplate(email, {
          recipientName: claimer.name,
          status: decision,
          reviewerName: admin.name,
          reviewNote: note,
          shift: emailShift(openShift),
          tierName: openShift.tier.name,
          ...prefs,
        }),
    });
  }
  audit(
    ctx,
    admin.id,
    `open_shift.${decision}`,
    { type: 'open_shift', id },
    { personName: claimer.name, startTime: openShift.startTime, endTime: openShift.endTime },
  );
  return getOpenShift(ctx, id);
}

/** Take an open shift down; whoever picked it up is told. */
export function cancelOpenShift(ctx: Ctx, admin: AuthUser, id: string): OpenShift {
  const t = tables(ctx.db);
  const row = load(ctx, id);
  if (row.status !== 'open' && row.status !== 'claimed') throw unavailable(row.status);
  const openShift = toOpenShift(ctx, row);
  t.openShifts.update(id, { status: 'cancelled' });
  const claimer = t.users.get(row.claimedBy);
  if (claimer && claimer.id !== admin.id) {
    notifyPerson(ctx, reader(claimer), {
      kind: 'open_shift_cancelled',
      render: (email, prefs) =>
        openShiftCancelledTemplate(email, {
          recipientName: claimer.name,
          shift: emailShift(openShift),
          tierName: openShift.tier.name,
          ...prefs,
        }),
    });
  }
  audit(
    ctx,
    admin.id,
    'open_shift.cancelled',
    { type: 'open_shift', id },
    { tierName: openShift.tier.name, startTime: openShift.startTime, endTime: openShift.endTime },
  );
  return getOpenShift(ctx, id);
}
