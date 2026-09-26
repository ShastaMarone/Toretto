import { addDays } from '@shared/time';
import type { Label, Person, Tier } from '@shared/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  createTier,
  createUser,
  defaultScheduleId,
  emails,
  login,
  nextMonday,
  shiftOn,
  type Agent,
  type TestContext,
} from './helpers';

let ctx: TestContext;
let admin: Agent;
let member: Agent;
let adminUser: { id: string; email: string };

beforeAll(async () => {
  ctx = await createTestContext();
  adminUser = await createUser(ctx.db, { name: 'Robin Admin', role: 'admin' });
  const memberUser = await createUser(ctx.db, { name: 'Mo Member' });
  admin = ctx.agent();
  member = ctx.agent();
  await login(admin, adminUser.email);
  await login(member, memberUser.email);
});
afterAll(async () => {
  await ctx.close();
});

describe('permissions', () => {
  it('requires sign-in for app data', async () => {
    const anon = ctx.agent();
    for (const path of [
      '/api/tiers',
      '/api/my/shifts?from=2026-01-01&to=2026-01-07',
      '/api/team/schedule?from=2026-01-01&to=2026-01-07',
    ]) {
      expect((await anon.get(path)).status, path).toBe(401);
    }
  });

  it('keeps admin tools admin-only', async () => {
    for (const [method, path] of [
      ['get', '/api/users'],
      ['get', '/api/schedules'],
      ['get', '/api/labels'],
      ['get', '/api/time-off'],
      ['get', '/api/admin/overview'],
      ['get', '/api/admin/settings'],
      ['post', '/api/tiers'],
      ['post', '/api/users'],
    ] as const) {
      expect((await member[method](path).send({})).status, `${method} ${path}`).toBe(403);
    }
  });

  it('returns JSON 404s for unknown API routes', async () => {
    const res = await admin.get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('hides the dev mailbox unless email goes to the console outside production', async () => {
    expect((await ctx.agent().get('/api/dev/mailbox')).status).toBe(200);
    const prod = await createTestContext({
      NODE_ENV: 'production',
      EMAIL_TRANSPORT: 'smtp',
      SMTP_URL: 'smtp://localhost:2525',
      ADMIN_EMAIL: 'x@example.com',
    });
    try {
      expect((await prod.agent().get('/api/dev/mailbox')).status).toBe(404);
    } finally {
      await prod.close();
    }
  });

  it('keeps the dev mailbox off for public URLs even if NODE_ENV was forgotten', async () => {
    const forgot = await createTestContext({
      NODE_ENV: 'development',
      APP_URL: 'https://schedule.example.com',
    });
    try {
      expect((await forgot.agent().get('/api/dev/mailbox')).status).toBe(404);
      expect((await forgot.agent().get('/api/bootstrap')).body.devMailbox).toBe(false);
    } finally {
      await forgot.close();
    }
  });
});

describe('tiers and labels', () => {
  let tier: Tier;

  it('creates, renames and recolors tiers', async () => {
    const res = await admin.post('/api/tiers').send({ name: 'Tier 1', color: '#4f46e5' });
    expect(res.status).toBe(201);
    tier = res.body;
    expect(tier.memberCount).toBe(0);
    const dup = await admin.post('/api/tiers').send({ name: 'tier 1', color: '#000000' });
    expect(dup.status).toBe(409);
    const badColor = await admin.post('/api/tiers').send({ name: 'Tier 9', color: 'red' });
    expect(badColor.status).toBe(400);
    expect(badColor.body.error.fields.color).toBeDefined();
    const renamed = await admin
      .patch(`/api/tiers/${tier.id}`)
      .send({ name: 'Tier One', color: '#111111' });
    expect(renamed.body).toMatchObject({ name: 'Tier One', color: '#111111' });
    expect((await member.get('/api/tiers')).body.map((t: Tier) => t.name)).toEqual(['Tier One']);
  });

  it('supports tier-specific and all-tier labels', async () => {
    const other = await createTier(ctx.db, 'Tier 2');
    const own = await admin
      .post('/api/labels')
      .send({ tierId: tier.id, name: 'Training', color: '#16a34a' });
    const global = await admin
      .post('/api/labels')
      .send({ tierId: null, name: 'On-Call', color: '#dc2626' });
    await admin.post('/api/labels').send({ tierId: other, name: 'Escalations', color: '#7c3aed' });
    expect(own.status).toBe(201);
    expect(global.body.tierId).toBeNull();
    // The same name can exist in another tier, but not twice in one.
    expect(
      (await admin.post('/api/labels').send({ tierId: other, name: 'Training', color: '#16a34a' }))
        .status,
    ).toBe(201);
    expect(
      (
        await admin
          .post('/api/labels')
          .send({ tierId: tier.id, name: 'training', color: '#16a34a' })
      ).status,
    ).toBe(409);

    const forTier = (await admin.get(`/api/labels?tierId=${tier.id}`)).body as Label[];
    expect(forTier.map((l) => l.name).sort()).toEqual(['On-Call', 'Training']);
  });

  it('refuses to delete a tier that people or shifts still use', async () => {
    const zed = await createUser(ctx.db, { name: 'Zed Zone', tierId: tier.id });
    const res = await admin.delete(`/api/tiers/${tier.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TIER_HAS_PEOPLE');

    // A tier label on a shift keeps the tier around too.
    const training = (await admin.get('/api/labels')).body.find(
      (l: Label) => l.tierId === tier.id && l.name === 'Training',
    );
    const main = await defaultScheduleId(ctx.db);
    const shift = await admin
      .post(`/api/schedules/${main}/shifts`)
      .send({ userId: zed.id, labelId: training.id, ...shiftOn(nextMonday()) })
      .expect(201);
    await admin.patch(`/api/users/${zed.id}`).send({ tierId: null }).expect(200);
    const labelled = await admin.delete(`/api/tiers/${tier.id}`);
    expect(labelled.body.error.code).toBe('TIER_LABELS_IN_USE');

    await admin.delete(`/api/shifts/${shift.body.id}`).expect(200);
    await admin.delete(`/api/tiers/${tier.id}`).expect(204);
  });
});

describe('people', () => {
  it('invites people into a tier and team', async () => {
    const tierId = await createTier(ctx.db, 'Tier 3');
    const team = await admin.post('/api/teams').send({ name: 'East' });
    const res = await admin
      .post('/api/users')
      .send({ name: 'Ivy Invitee', email: 'IVY@example.com', tierId, teamId: team.body.id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      email: 'ivy@example.com',
      status: 'invited',
      role: 'member',
      tierId,
    });
    expect(await emails(ctx.db, { to: 'ivy@example.com', kind: 'invite' })).toHaveLength(1);
    const dup = await admin
      .post('/api/users')
      .send({ name: 'Ivy Again', email: 'ivy@example.com' });
    expect(dup.status).toBe(409);
    expect((await member.get('/api/teams')).body[0]).toMatchObject({
      name: 'East',
      memberCount: 1,
    });
  });

  it('can fix an invite email typo, which re-sends the invite', async () => {
    const { body: person } = await admin
      .post('/api/users')
      .send({ name: 'Typo Tom', email: 'tom@exampel.com' });
    const res = await admin.patch(`/api/users/${person.id}`).send({ email: 'tom@example.com' });
    expect(res.body.email).toBe('tom@example.com');
    expect(await emails(ctx.db, { to: 'tom@example.com', kind: 'invite' })).toHaveLength(1);
  });

  it('never leaves the organization without an admin', async () => {
    const demote = await admin.patch(`/api/users/${adminUser.id}`).send({ role: 'member' });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe('LAST_ADMIN');
    const self = await admin.patch(`/api/users/${adminUser.id}`).send({ active: false });
    expect(self.status).toBe(403);
  });

  it('deactivates instead of deleting people with shifts', async () => {
    const tierId = await createTier(ctx.db, 'Tier 4');
    const worker = await createUser(ctx.db, { name: 'Wes Worker', tierId });
    const monday = nextMonday();
    await admin
      .post(`/api/schedules/${await defaultScheduleId(ctx.db)}/shifts`)
      .send({ userId: worker.id, ...shiftOn(addDays(monday, 1)) })
      .expect(201);

    const del = await admin.delete(`/api/users/${worker.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('USER_HAS_SHIFTS');

    const workerAgent = ctx.agent();
    await login(workerAgent, worker.email);
    const off = await admin.patch(`/api/users/${worker.id}`).send({ active: false });
    expect(off.body.status).toBe('deactivated');
    expect((await workerAgent.get('/api/bootstrap')).body.user).toBeNull();
    const on = await admin.patch(`/api/users/${worker.id}`).send({ active: true });
    expect(on.body.status).toBe('active');

    const list = (await admin.get('/api/users')).body as Person[];
    expect(list.find((p) => p.id === worker.id)!.shiftCount).toBe(1);
  });

  it('records an audit trail', async () => {
    const { body } = await admin.get('/api/admin/activity?limit=100');
    const actions = body.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'user.invited',
        'user.deactivated',
        'user.reactivated',
        'tier.created',
      ]),
    );
    expect(body[0].actorName).toBe('Robin Admin');
  });
});

describe('settings', () => {
  it('updates organization settings with validation', async () => {
    const res = await admin.patch('/api/admin/settings').send({
      orgName: 'Support Org',
      timezone: 'America/Edmonton',
      weekStartsOn: 0,
      reminderHours: 12,
    });
    expect(res.body).toMatchObject({
      orgName: 'Support Org',
      timezone: 'America/Edmonton',
      weekStartsOn: 0,
      reminderHours: 12,
    });
    expect(
      (await admin.patch('/api/admin/settings').send({ timezone: 'Mars/Olympus' })).status,
    ).toBe(400);
    expect(
      (await admin.patch('/api/admin/settings').send({ allowedDomains: ['not a domain'] })).status,
    ).toBe(400);
    const boot = await member.get('/api/bootstrap');
    expect(boot.body.org).toEqual({
      name: 'Support Org',
      timezone: 'America/Edmonton',
      weekStartsOn: 0,
      holidayRegion: 'CA',
      timeFormat: '12h',
    });
    const alberta = await admin.patch('/api/admin/settings').send({ holidayRegion: 'AB' });
    expect(alberta.body.holidayRegion).toBe('AB');
    expect((await admin.patch('/api/admin/settings').send({ holidayRegion: 'XX' })).status).toBe(
      400,
    );
    const clock = await admin.patch('/api/admin/settings').send({ timeFormat: '24h' });
    expect(clock.body.timeFormat).toBe('24h');
    expect((await member.get('/api/bootstrap')).body.org.timeFormat).toBe('24h');
    expect((await admin.patch('/api/admin/settings').send({ timeFormat: '25h' })).status).toBe(400);
    await admin.patch('/api/admin/settings').send({ timeFormat: '12h' });
  });

  it('keeps the email log for 90 days unless changed', async () => {
    expect((await admin.get('/api/admin/settings')).body.emailRetentionDays).toBe(90);
    const forever = await admin.patch('/api/admin/settings').send({ emailRetentionDays: null });
    expect(forever.body.emailRetentionDays).toBeNull();
    // Leaving it out keeps the current choice.
    const unchanged = await admin.patch('/api/admin/settings').send({ reminderHours: 24 });
    expect(unchanged.body.emailRetentionDays).toBeNull();
    const month = await admin.patch('/api/admin/settings').send({ emailRetentionDays: 30 });
    expect(month.body.emailRetentionDays).toBe(30);
    for (const bad of [0, 5000, 1.5, '30']) {
      const res = await admin.patch('/api/admin/settings').send({ emailRetentionDays: bad });
      expect(res.status).toBe(400);
    }
    await admin.patch('/api/admin/settings').send({ emailRetentionDays: 90 });
  });

  it('lets people set their own time zone', async () => {
    const res = await member.patch('/api/me').send({ timezone: 'America/Halifax', name: 'Mo M.' });
    expect(res.body.user).toMatchObject({ timezone: 'America/Halifax', name: 'Mo M.' });
    const reset = await member.patch('/api/me').send({ timezone: null });
    expect(reset.body.user.timezone).toBeNull();
  });

  it('lets people pick 12- or 24-hour times, or follow the organization', async () => {
    expect((await member.get('/api/bootstrap')).body.user.timeFormat).toBeNull();
    const own = await member.patch('/api/me').send({ timeFormat: '24h' });
    expect(own.body.user.timeFormat).toBe('24h');
    // Other profile edits leave it alone.
    const renamed = await member.patch('/api/me').send({ name: 'Mo M.' });
    expect(renamed.body.user.timeFormat).toBe('24h');
    expect((await member.patch('/api/me').send({ timeFormat: 'metric' })).status).toBe(400);
    const reset = await member.patch('/api/me').send({ timeFormat: null });
    expect(reset.body.user.timeFormat).toBeNull();
  });

  it('changes a password after checking the current one', async () => {
    const wrong = await member
      .post('/api/me/password')
      .send({ currentPassword: 'nope', newPassword: 'new password 1' });
    expect(wrong.status).toBe(400);
    const ok = await member
      .post('/api/me/password')
      .send({ currentPassword: 'password123', newPassword: 'new password 1' });
    expect(ok.status).toBe(200);
  });
});
