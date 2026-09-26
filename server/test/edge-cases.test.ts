import { addDays, todayIn } from '@shared/time';
import type { BuilderShift } from '@shared/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearEmails,
  createLabel,
  createTestContext,
  createTier,
  createUser,
  defaultScheduleId,
  emails,
  login,
  nextMonday,
  shiftOn,
  TZ,
  type Agent,
  type TestContext,
} from './helpers';

// Regression tests for edge cases found in review: each reproduces a scenario
// that used to misbehave.

let ctx: TestContext;
let admin: Agent;
let main: string;
let tier1: string;
let tier2: string;
let label: string;
let ana: { id: string; email: string };
const monday = nextMonday();
const day = (n: number) => addDays(monday, n);
let weekOffset = 0;

beforeAll(async () => {
  ctx = await createTestContext();
  main = await defaultScheduleId(ctx.db);
  tier1 = await createTier(ctx.db, 'Tier 1');
  tier2 = await createTier(ctx.db, 'Tier 2');
  label = await createLabel(ctx.db, 'Chat Queue', tier1);
  const robin = await createUser(ctx.db, { name: 'Robin Admin', role: 'admin' });
  ana = await createUser(ctx.db, { name: 'Ana Ortiz', tierId: tier1 });
  admin = ctx.agent();
  await login(admin, robin.email);
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(() => clearEmails(ctx.db));

/** A fresh week (each test gets its own to avoid overlaps). */
function newWeek() {
  const start = day(7 * ++weekOffset);
  return { start, range: { from: start, to: addDays(start, 6) } };
}

async function addShift(
  date: string,
  extra: Record<string, unknown> = {},
  scheduleId = main,
): Promise<BuilderShift> {
  const res = await admin
    .post(`/api/schedules/${scheduleId}/shifts`)
    .send({ userId: ana.id, ...shiftOn(date), ...extra });
  expect(res.status, res.text).toBe(201);
  return res.body as BuilderShift;
}

describe('editing shifts', () => {
  it('keeps the label when a shift is moved (drag and drop sends no labelId)', async () => {
    const { start } = newWeek();
    const shift = await addShift(start, { labelId: label });
    const moved = await admin
      .patch(`/api/shifts/${shift.id}`)
      .send({ userId: ana.id, ...shiftOn(addDays(start, 1)) });
    expect(moved.body.labelId).toBe(label);
    const noted = await admin.patch(`/api/shifts/${shift.id}`).send({ notes: 'Bring headset' });
    expect(noted.body).toMatchObject({ labelId: label, notes: 'Bring headset' });
    const cleared = await admin.patch(`/api/shifts/${shift.id}`).send({ labelId: null });
    expect(cleared.body.labelId).toBeNull();
  });

  it("won't hand a tier label to someone outside that tier", async () => {
    const { start } = newWeek();
    const cy = await createUser(ctx.db, { name: 'Cy Tran', tierId: tier2 });
    const shift = await addShift(start, { labelId: label });
    const res = await admin.patch(`/api/shifts/${shift.id}`).send({ userId: cy.id });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toEqual({ labelId: 'Wrong tier' });
    // Without the label it's fine.
    await admin.patch(`/api/shifts/${shift.id}`).send({ userId: cy.id, labelId: null }).expect(200);
  });
});

describe('discarding changes', () => {
  it('refuses when restoring the published version would double-book someone', async () => {
    const { start, range } = newWeek();
    const x = await addShift(start);
    await admin.post(`/api/schedules/${main}/publish`).send(range).expect(200);
    await admin.delete(`/api/shifts/${x.id}`).expect(200); // pending removal

    // Meanwhile Ana is booked at the same time on another schedule.
    const other = await admin.post('/api/schedules').send({ name: 'Projects' });
    await addShift(start, {}, other.body.id);

    const res = await admin.post(`/api/schedules/${main}/discard-changes`).send(range);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SHIFT_OVERLAP');
    const b = await admin.get(`/api/schedules/${main}?from=${range.from}&to=${range.to}`);
    expect(b.body.removedShifts.map((s: BuilderShift) => s.id)).toEqual([x.id]);
  });
});

describe('time off', () => {
  it("doesn't reveal draft shifts to members through conflict counts", async () => {
    const { start } = newWeek();
    await addShift(start); // stays a draft
    const member = ctx.agent();
    await login(member, ana.email);
    const { body: types } = await member.get('/api/time-off-types');
    const res = await member
      .post('/api/my/time-off')
      .send({ typeId: types[0].id, startDate: start, endDate: start });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('conflicts');
    const mine = await member.get('/api/my/time-off');
    expect(mine.body[0]).not.toHaveProperty('conflicts');
    const adminView = await admin.get('/api/time-off?status=pending');
    expect(adminView.body.find((r: { id: string }) => r.id === res.body.id).conflicts).toBe(1);
  });

  it("counts conflicts on the organization's calendar days, like the builder", async () => {
    const tokyo = await createUser(ctx.db, {
      name: 'Kenji Far',
      tierId: tier1,
      timezone: 'Asia/Tokyo',
    });
    const { start } = newWeek();
    // Noon to 8pm Toronto on the first day — already the next day in Tokyo.
    await admin
      .post(`/api/schedules/${main}/shifts`)
      .send({ userId: tokyo.id, ...shiftOn(start, '12:00', '20:00') })
      .expect(201);
    const member = ctx.agent();
    await login(member, tokyo.email);
    const { body: types } = await member.get('/api/time-off-types');
    const { body: request } = await member
      .post('/api/my/time-off')
      .send({ typeId: types[0].id, startDate: start, endDate: start });
    const adminView = await admin.get('/api/time-off?status=pending');
    expect(adminView.body.find((r: { id: string }) => r.id === request.id).conflicts).toBe(1);
  });
});

describe('publishing', () => {
  it('still tells people when an upcoming shift is moved into the past', async () => {
    const today = todayIn(TZ);
    const range = { from: addDays(today, -3), to: addDays(today, 3) };
    const shift = await addShift(addDays(today, 2));
    await admin.post(`/api/schedules/${main}/publish`).send(range).expect(200);
    await clearEmails(ctx.db);
    await admin
      .patch(`/api/shifts/${shift.id}`)
      .send(shiftOn(addDays(today, -2)))
      .expect(200);
    const result = await admin.post(`/api/schedules/${main}/publish`).send(range);
    expect(result.body.emailsQueued).toBe(1);
    const [mail] = await emails(ctx.db, { to: ana.email });
    expect(mail!.kind).toBe('schedule_updated');
  });

  it('asks for both ends of a date range', async () => {
    const res = await admin.post(`/api/schedules/${main}/publish`).send({ from: day(0) });
    expect(res.status).toBe(400);
  });
});

describe('admin safety', () => {
  it("doesn't count an invited admin who never signed in as another admin", async () => {
    const solo = await createTestContext();
    try {
      const only = await createUser(solo.db, { name: 'Only Admin', role: 'admin' });
      const agent = solo.agent();
      await login(agent, only.email);
      await agent
        .post('/api/users')
        .send({ name: 'Typo Admin', email: 'admin@exmaple.com', role: 'admin' })
        .expect(201);
      const res = await agent.patch(`/api/users/${only.id}`).send({ role: 'member' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LAST_ADMIN');
    } finally {
      await solo.close();
    }
  });

  it('keeps an admin when two admins demote themselves at the same moment', async () => {
    for (let round = 0; round < 3; round++) {
      const solo = await createTestContext();
      try {
        const a = await createUser(solo.db, { name: 'Admin A', role: 'admin' });
        const b = await createUser(solo.db, { name: 'Admin B', role: 'admin' });
        const [agentA, agentB] = [solo.agent(), solo.agent()];
        await login(agentA, a.email);
        await login(agentB, b.email);
        const results = await Promise.all([
          agentA.patch(`/api/users/${a.id}`).send({ role: 'member' }),
          agentB.patch(`/api/users/${b.id}`).send({ role: 'member' }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        const { rows } = await solo.db.query(
          `SELECT count(*)::int AS n FROM users WHERE role = 'admin'`,
        );
        expect(rows[0].n).toBe(1);
      } finally {
        await solo.close();
      }
    }
  });

  it('lets two admins demote each other at once without a server error', async () => {
    const solo = await createTestContext();
    try {
      const a = await createUser(solo.db, { name: 'Admin A', role: 'admin' });
      const b = await createUser(solo.db, { name: 'Admin B', role: 'admin' });
      const [agentA, agentB] = [solo.agent(), solo.agent()];
      await login(agentA, a.email);
      await login(agentB, b.email);
      const results = await Promise.all([
        agentA.patch(`/api/users/${b.id}`).send({ role: 'member' }),
        agentB.patch(`/api/users/${a.id}`).send({ role: 'member' }),
      ]);
      expect(results.every((r) => r.status < 500)).toBe(true);
      const { rows } = await solo.db.query(
        `SELECT count(*)::int AS n FROM users WHERE role = 'admin'`,
      );
      expect(rows[0].n).toBeGreaterThanOrEqual(1);
    } finally {
      await solo.close();
    }
  });
});
