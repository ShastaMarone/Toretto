import type { Bootstrap, Person, Role, SessionUser } from '@shared/types';
import { googleInviteTemplate } from '../../../server/src/email/templates';
import { badRequest, conflict, forbidden, notFound } from '../../../server/src/errors';
import { audit, authUser, byName, getSettings, ms, tables, type Ctx } from '../core';
import type { UserRow } from '../db/schema';
import { emailContext, enqueueEmail } from './mail';

/** robin.smith@example.com → "Robin Smith": a starting name people can change in Profile. */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  const words = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return (words.join(' ') || email).slice(0, 100);
}

const allowed = (email: string, domains: string[]) =>
  domains.length === 0 || domains.includes(email.split('@')[1] ?? '');

/**
 * Who's signed in, and the organization basics. First visits count as
 * joining; with self sign-up on, someone new in an allowed domain joins as a
 * team member.
 */
export function bootstrap(ctx: Ctx): Bootstrap {
  const t = tables(ctx.db);
  const settings = getSettings(ctx.db);
  let row = ctx.user ? t.users.get(ctx.user.id) : undefined;
  if (row) {
    const patch: Partial<UserRow> = {};
    if (!row.emailVerifiedAt) patch.emailVerifiedAt = ctx.now;
    if (!row.lastLoginAt || ms(ctx.now) - ms(row.lastLoginAt) > 3_600_000) {
      patch.lastLoginAt = ctx.now;
    }
    if (Object.keys(patch).length) row = t.users.update(row.id, patch);
  } else if (
    ctx.email &&
    settings.selfSignup &&
    allowed(ctx.email, settings.allowedDomains) &&
    !t.users.find((u) => u.email === ctx.email)
  ) {
    row = t.users.insert({
      name: nameFromEmail(ctx.email),
      email: ctx.email,
      role: 'member',
      emailVerifiedAt: ctx.now,
      lastLoginAt: ctx.now,
    });
    audit(ctx, row.id, 'user.signed_up', { type: 'user', id: row.id }, { name: row.name });
  }
  const user = row && !row.deactivatedAt ? authUser(row) : null;
  if (user) ctx.user = user;
  return {
    user,
    org: {
      name: settings.orgName,
      timezone: settings.timezone,
      weekStartsOn: settings.weekStartsOn,
      holidayRegion: settings.holidayRegion,
      timeFormat: settings.timeFormat,
    },
    setupRequired: false,
    selfSignup: settings.selfSignup,
    allowedDomains: settings.allowedDomains,
    devMailbox: false,
    emailConfigured: true,
    signIn: 'google',
    calendarFeed: false,
    signedInAs: user ? null : ctx.email || null,
  };
}

export function toPerson(ctx: Ctx, u: UserRow): Person {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    tierId: u.tierId,
    teamId: u.teamId,
    timezone: u.timezone,
    status: u.deactivatedAt ? 'deactivated' : u.emailVerifiedAt ? 'active' : 'invited',
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    shiftCount: tables(ctx.db).shifts.where((s) => s.userId === u.id && !s.deletedAt).length,
  };
}

export function getPerson(ctx: Ctx, id: string): Person {
  const row = tables(ctx.db).users.get(id);
  if (!row) throw notFound('Person');
  return toPerson(ctx, row);
}

export function listPeople(ctx: Ctx): Person[] {
  return tables(ctx.db)
    .users.all()
    .sort((a, b) => Number(!!a.deactivatedAt) - Number(!!b.deactivatedAt) || byName(a, b))
    .map((u) => toPerson(ctx, u));
}

function assertRefs(ctx: Ctx, tierId?: string | null, teamId?: string | null): void {
  const t = tables(ctx.db);
  if (tierId && !t.tiers.get(tierId)) throw notFound('Tier');
  if (teamId && !t.teams.get(teamId)) throw notFound('Team');
}

/** Refuse changes that would leave the organization without an active admin. */
function assertOtherAdmin(ctx: Ctx, userId: string): void {
  const other = tables(ctx.db).users.find(
    (u) => u.role === 'admin' && !u.deactivatedAt && u.emailVerifiedAt !== null && u.id !== userId,
  );
  if (!other) {
    throw conflict(
      'There must always be at least one active admin who has signed in.',
      'LAST_ADMIN',
    );
  }
}

const emailTaken = () =>
  conflict('Someone with this email address is already on the team.', 'EMAIL_TAKEN');

function sendInvite(
  ctx: Ctx,
  person: { id: string; name: string; email: string },
  inviter: string,
) {
  enqueueEmail(ctx, {
    userId: person.id,
    to: person.email,
    kind: 'invite',
    email: googleInviteTemplate(emailContext(ctx), {
      name: person.name,
      inviterName: inviter,
      url: `${ctx.appUrl}/my-schedule`,
    }),
  });
}

/** Add someone to the team and email them the link. They sign in with Google. */
export function invitePerson(
  ctx: Ctx,
  input: { name: string; email: string; role: Role; tierId: string | null; teamId: string | null },
): Person {
  const admin = ctx.user!;
  const t = tables(ctx.db);
  assertRefs(ctx, input.tierId, input.teamId);
  if (t.users.find((u) => u.email === input.email)) throw emailTaken();
  const row = t.users.insert({
    name: input.name,
    email: input.email,
    role: input.role,
    tierId: input.tierId,
    teamId: input.teamId,
    invitedAt: ctx.now,
    invitedBy: admin.id,
  });
  sendInvite(ctx, row, admin.name);
  audit(
    ctx,
    admin.id,
    'user.invited',
    { type: 'user', id: row.id },
    { name: row.name, email: row.email, role: input.role },
  );
  return toPerson(ctx, row);
}

export function updatePerson(
  ctx: Ctx,
  id: string,
  body: {
    name?: string;
    email?: string;
    role?: Role;
    tierId?: string | null;
    teamId?: string | null;
    timezone?: string | null;
    active?: boolean;
  },
): Person {
  const admin = ctx.user!;
  const t = tables(ctx.db);
  const current = t.users.get(id);
  if (!current) throw notFound('Person');
  assertRefs(ctx, body.tierId, body.teamId);
  const emailChanged = body.email !== undefined && body.email !== current.email;
  if (emailChanged) {
    if (current.emailVerifiedAt) {
      throw badRequest('Email addresses can only be changed before someone accepts their invite.', {
        email: 'Already confirmed',
      });
    }
    if (t.users.find((u) => u.email === body.email)) throw emailTaken();
  }
  const active = !current.deactivatedAt;
  const demoting = current.role === 'admin' && body.role === 'member';
  const deactivating = active && body.active === false;
  if (deactivating && id === admin.id) throw forbidden("You can't deactivate your own account.");
  if (current.role === 'admin' && active && (demoting || deactivating)) {
    assertOtherAdmin(ctx, id);
  }
  const patch: Partial<UserRow> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (emailChanged) patch.email = body.email!;
  if (body.role !== undefined) patch.role = body.role;
  if (body.tierId !== undefined) patch.tierId = body.tierId;
  if (body.teamId !== undefined) patch.teamId = body.teamId;
  if (body.timezone !== undefined) patch.timezone = body.timezone;
  if (body.active === true) patch.deactivatedAt = null;
  if (body.active === false) patch.deactivatedAt = current.deactivatedAt ?? ctx.now;
  t.users.update(id, patch);
  const action = deactivating
    ? 'user.deactivated'
    : body.active === true && !active
      ? 'user.reactivated'
      : 'user.updated';
  audit(
    ctx,
    admin.id,
    action,
    { type: 'user', id },
    {
      name: body.name ?? current.name,
      ...Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'active')),
    },
  );
  // A corrected address gets the invite again.
  if (emailChanged) sendInvite(ctx, t.users.get(id)!, admin.name);
  return getPerson(ctx, id);
}

export function resendInvite(ctx: Ctx, id: string): Person {
  const person = getPerson(ctx, id);
  if (person.status !== 'invited') {
    throw badRequest(
      person.status === 'active'
        ? `${person.name} has already accepted their invite.`
        : `${person.name} is deactivated.`,
    );
  }
  sendInvite(ctx, person, ctx.user!.name);
  audit(ctx, ctx.user!.id, 'user.invite_resent', { type: 'user', id }, { name: person.name });
  return person;
}

/**
 * Delete someone who never had shifts. Their time off and swaps go with
 * them; an open shift they'd picked up opens up again. (Other references to
 * them, like "reviewed by", read as nobody.)
 */
export function deletePerson(ctx: Ctx, id: string): void {
  const t = tables(ctx.db);
  if (id === ctx.user!.id) throw forbidden("You can't delete your own account.");
  const person = t.users.get(id);
  if (!person) throw notFound('Person');
  if (t.shifts.find((s) => s.userId === id || s.publishedUserId === id)) {
    throw conflict(
      `${person.name} has shifts on the schedule. Deactivate them instead so their history is kept.`,
      'USER_HAS_SHIFTS',
    );
  }
  if (person.role === 'admin' && !person.deactivatedAt) assertOtherAdmin(ctx, id);
  for (const r of t.timeOff.where((r) => r.userId === id)) t.timeOff.delete(r.id);
  for (const w of t.swaps.where((w) => w.requesterId === id || w.recipientId === id)) {
    t.swaps.delete(w.id);
  }
  for (const o of t.openShifts.where((o) => o.claimedBy === id)) {
    t.openShifts.update(
      o.id,
      o.status === 'claimed'
        ? { status: 'open', claimedBy: null, claimedAt: null }
        : { claimedBy: null },
    );
  }
  t.users.delete(id);
  audit(ctx, ctx.user!.id, 'user.deleted', { type: 'user', id }, { name: person.name });
}

/** Profile changes: name, zone, time format, admin email choices. */
export function updateMe(
  ctx: Ctx,
  body: {
    name?: string;
    timezone?: string | null;
    timeFormat?: '12h' | '24h' | null;
    notifyTimeOff?: boolean;
    notifyConfirmations?: boolean;
    notifySwaps?: boolean;
  },
): { user: SessionUser } {
  const t = tables(ctx.db);
  const patch: Partial<UserRow> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.timezone !== undefined) patch.timezone = body.timezone;
  if (body.timeFormat !== undefined) patch.timeFormat = body.timeFormat;
  if (body.notifyTimeOff !== undefined) patch.notifyTimeOff = body.notifyTimeOff;
  if (body.notifyConfirmations !== undefined) patch.notifyConfirmations = body.notifyConfirmations;
  if (body.notifySwaps !== undefined) patch.notifySwaps = body.notifySwaps;
  const row = t.users.update(ctx.user!.id, patch);
  return { user: authUser(row) };
}
