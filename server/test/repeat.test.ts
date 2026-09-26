import { addDays } from '@shared/time';
import type { BuilderShift, RepeatResult, ScheduleRange } from '@shared/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLabel,
  createTestContext,
  createTier,
  createUser,
  defaultScheduleId,
  login,
  nextMonday,
  shiftOn,
  type Agent,
  type TestContext,
} from './helpers';

// Adding a repeating shift: one ordinary draft per day, skipping days the
// person can't work.

let ctx: TestContext;
let admin: Agent;
let member: Agent;
let main: string;
let extra: string;
let tier1Label: string;
let tier2Label: string;
let ana: { id: string; email: string };
let bo: { id: string; email: string };
const monday = nextMonday();
const day = (n: number) => addDays(monday, n);

beforeAll(async () => {
  ctx = await createTestContext();
  main = await defaultScheduleId(ctx.db);
  const tier1 = await createTier(ctx.db, 'Tier 1');
  const tier2 = await createTier(ctx.db, 'Tier 2');
  tier1Label = await createLabel(ctx.db, 'Chat Queue', tier1);
  tier2Label = await createLabel(ctx.db, 'Escalations', tier2);
  const boss = await createUser(ctx.db, { name: 'Robin Admin', role: 'admin' });
  ana = await createUser(ctx.db, { name: 'Ana Ortiz', tierId: tier1 });
  bo = await createUser(ctx.db, { name: 'Bo Lee', tierId: tier1 });
  admin = ctx.agent();
  member = ctx.agent();
  await login(admin, boss.email);
  await login(member, ana.email);
  extra = (await admin.post('/api/schedules').send({ name: 'Projects' })).body.id;
});
afterAll(async () => {
  await ctx.close();
});

const week = (days: number[], start = '09:00', end = '17:00') =>
  days.map((n) => shiftOn(day(n), start, end));

async function repeat(body: Record<string, unknown>, scheduleId = main) {
  return admin.post(`/api/schedules/${scheduleId}/shifts/bulk`).send(body);
}

async function draftsFor(userId: string, from: string, to: string): Promise<BuilderShift[]> {
  const res = await admin.get(`/api/schedules/${main}?from=${from}&to=${to}`);
  return (res.body as ScheduleRange).shifts.filter((s) => s.userId === userId);
}

describe('repeating shifts', () => {
  it('adds Monday to Friday as five separate drafts', async () => {
    const res = await repeat({
      userId: ana.id,
      labelId: tier1Label,
      notes: 'Front desk',
      shifts: week([0, 1, 2, 3, 4]),
    });
    expect(res.status).toBe(201);
    expect(res.body as RepeatResult).toEqual({ created: 5, skipped: [] });

    const drafts = await draftsFor(ana.id, day(0), day(6));
    expect(drafts).toHaveLength(5);
    for (const s of drafts) {
      expect(s).toMatchObject({ labelId: tier1Label, notes: 'Front desk', changeState: 'new' });
    }

    // Each one is its own shift: change one day without touching the others.
    const thursday = drafts[3]!;
    const moved = await admin
      .patch(`/api/shifts/${thursday.id}`)
      .send(shiftOn(day(3), '12:00', '20:00'));
    expect(moved.status).toBe(200);
    const after = await draftsFor(ana.id, day(0), day(6));
    expect(after.filter((s) => s.startTime === shiftOn(day(0)).startTime)).toHaveLength(1);
    expect(after.find((s) => s.id === thursday.id)!.startTime).toBe(
      shiftOn(day(3), '12:00').startTime,
    );
  });

  it('skips days with approved time off or another shift, on any schedule', async () => {
    const { rows } = await ctx.db.query<{ id: string }>(
      `SELECT id FROM time_off_types WHERE name = 'Vacation'`,
    );
    await ctx.db.query(
      `INSERT INTO time_off_requests (user_id, type_id, start_date, end_date, status)
       VALUES ($1, $2, $3, $3, 'approved'), ($1, $2, $4, $4, 'pending')`,
      [bo.id, rows[0]!.id, day(8), day(9)],
    );
    const other = await admin
      .post(`/api/schedules/${extra}/shifts`)
      .send({ userId: bo.id, ...shiftOn(day(10), '08:00', '12:00') });
    expect(other.status).toBe(201);

    const res = await repeat({ userId: bo.id, shifts: week([7, 8, 9, 10, 11]) });
    expect(res.status).toBe(201);
    const result = res.body as RepeatResult;
    expect(result.created).toBe(3); // pending time off doesn't block a day
    expect(result.skipped).toEqual([
      { ...shiftOn(day(8)), reason: 'time_off', detail: 'Vacation' },
      { ...shiftOn(day(10)), reason: 'overlap', detail: 'already has a shift on Projects' },
    ]);
    expect((await draftsFor(bo.id, day(7), day(13))).map((s) => s.startTime)).toEqual(
      [7, 9, 11].map((n) => shiftOn(day(n)).startTime),
    );

    // Repeating over the same days again adds nothing.
    const again = await repeat({ userId: bo.id, shifts: week([7, 9, 11]) });
    expect(again.body).toMatchObject({ created: 0 });
    expect((again.body as RepeatResult).skipped.map((s) => s.detail)).toEqual([
      'already has a shift',
      'already has a shift',
      'already has a shift',
    ]);
  });

  it('checks the person, label and times like a single shift', async () => {
    const wrongTier = await repeat({
      userId: ana.id,
      labelId: tier2Label,
      shifts: week([14, 15]),
    });
    expect(wrongTier.status).toBe(400);
    expect(wrongTier.body.error.fields).toMatchObject({ labelId: 'Wrong tier' });

    // Ends before it starts.
    const times = shiftOn(day(14));
    const reversed = await repeat({
      userId: ana.id,
      shifts: [{ startTime: times.endTime, endTime: times.startTime }],
    });
    expect(reversed.status).toBe(400);

    expect((await repeat({ userId: ana.id, shifts: [] })).status).toBe(400);
    const tooMany = Array.from({ length: 201 }, (_, i) => shiftOn(addDays(day(0), i)));
    expect((await repeat({ userId: ana.id, shifts: tooMany })).status).toBe(400);

    await ctx.db.query('UPDATE users SET deactivated_at = now() WHERE id = $1', [bo.id]);
    const gone = await repeat({ userId: bo.id, shifts: week([21]) });
    expect(gone.status).toBe(400);
    expect(gone.body.error.fields).toMatchObject({ userId: 'Deactivated' });
    await ctx.db.query('UPDATE users SET deactivated_at = NULL WHERE id = $1', [bo.id]);

    // Nothing was half-created by the failed requests.
    expect(await draftsFor(ana.id, day(14), day(20))).toEqual([]);
  });

  it('is for admins only', async () => {
    const res = await member
      .post(`/api/schedules/${main}/shifts/bulk`)
      .send({ userId: ana.id, shifts: week([28]) });
    expect(res.status).toBe(403);
  });
});
