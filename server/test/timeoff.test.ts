import { addDays } from '@shared/time';
import type { TimeOffRequest, TimeOffType } from '@shared/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearEmails,
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
let priya: Agent;
let sam: Agent;
let types: Record<string, TimeOffType>;
const people: Record<string, { id: string; email: string }> = {};
const monday = nextMonday();
const day = (n: number) => addDays(monday, n);

beforeAll(async () => {
  ctx = await createTestContext();
  const tier = await createTier(ctx.db, 'Tier 1');
  people.admin = await createUser(ctx.db, { name: 'Robin Admin', role: 'admin' });
  people.second = await createUser(ctx.db, { name: 'Second Admin', role: 'admin' });
  people.priya = await createUser(ctx.db, { name: 'Priya Patel', tierId: tier });
  people.sam = await createUser(ctx.db, { name: 'Sam Chen', tierId: tier });
  admin = ctx.agent();
  priya = ctx.agent();
  sam = ctx.agent();
  await login(admin, people.admin!.email);
  await login(priya, people.priya!.email);
  await login(sam, people.sam!.email);
  const list = (await priya.get('/api/time-off-types')).body as TimeOffType[];
  types = Object.fromEntries(list.map((t) => [t.name, t]));

  // Priya has a published shift on Wednesday.
  const main = await defaultScheduleId(ctx.db);
  await admin
    .post(`/api/schedules/${main}/shifts`)
    .send({ userId: people.priya!.id, ...shiftOn(day(2)) })
    .expect(201);
  await admin.post(`/api/schedules/${main}/publish`).send({}).expect(200);
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(() => clearEmails(ctx.db));

describe('time-off types', () => {
  it('ships with the common types', () => {
    expect(Object.keys(types)).toEqual([
      'Paid Holiday',
      'Personal Day',
      'Vacation',
      'Sick Day',
      'Unpaid Leave',
    ]);
    expect(types['Unpaid Leave']!.paid).toBe(false);
  });

  it('lets admins add and archive types, which hides them from requests', async () => {
    const created = await admin
      .post('/api/time-off-types')
      .send({ name: 'Bereavement', color: '#475569' });
    expect(created.status).toBe(201);
    await admin
      .patch(`/api/time-off-types/${created.body.id}`)
      .send({ archived: true })
      .expect(200);
    const visible = (await priya.get('/api/time-off-types')).body.map((t: TimeOffType) => t.name);
    expect(visible).not.toContain('Bereavement');
    const all = (await admin.get('/api/time-off-types?all=1')).body.map((t: TimeOffType) => t.name);
    expect(all).toContain('Bereavement');
    const request = await priya
      .post('/api/my/time-off')
      .send({ typeId: created.body.id, startDate: day(20), endDate: day(20) });
    expect(request.status).toBe(400);
    expect(
      (await priya.post('/api/time-off-types').send({ name: 'Mine', color: '#000000' })).status,
    ).toBe(403);
  });
});

describe('requesting time off', () => {
  let vacation: TimeOffRequest;

  it('creates a pending request and emails every admin', async () => {
    const res = await priya.post('/api/my/time-off').send({
      typeId: types.Vacation!.id,
      startDate: day(1),
      endDate: day(3),
      note: 'Family trip',
    });
    expect(res.status).toBe(201);
    vacation = res.body;
    expect(vacation).toMatchObject({
      status: 'pending',
      startDate: day(1),
      endDate: day(3),
      note: 'Family trip',
    });
    expect(vacation.type.name).toBe('Vacation');

    const sent = await emails(ctx.db, { kind: 'time_off_requested' });
    expect(sent.map((e) => e.toEmail).sort()).toEqual(
      [people.admin!.email, people.second!.email].sort(),
    );
    expect(sent[0]!.subject).toContain('Priya Patel · Vacation');
    expect(sent[0]!.text).toContain('(3 days)');
    expect(sent[0]!.text).toContain("They're scheduled for 1 shift during this time.");
  });

  it('rejects overlapping requests and backwards dates', async () => {
    const overlap = await priya
      .post('/api/my/time-off')
      .send({ typeId: types['Personal Day']!.id, startDate: day(3), endDate: day(3) });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('TIME_OFF_OVERLAP');
    const backwards = await priya
      .post('/api/my/time-off')
      .send({ typeId: types['Personal Day']!.id, startDate: day(5), endDate: day(4) });
    expect(backwards.status).toBe(400);
  });

  it('shows admins the conflicting shifts, then notifies the person when approved', async () => {
    const pending = (await admin.get('/api/time-off?status=pending')).body as TimeOffRequest[];
    expect(pending).toHaveLength(1);
    expect(pending[0]!.conflicts).toBe(1);
    expect(pending[0]!.userName).toBe('Priya Patel');

    const res = await admin.post(`/api/time-off/${vacation.id}/approve`).send({ note: 'Enjoy!' });
    expect(res.body).toMatchObject({
      status: 'approved',
      reviewedByName: 'Robin Admin',
      reviewNote: 'Enjoy!',
    });
    const [mail] = await emails(ctx.db, { to: people.priya!.email });
    expect(mail!.kind).toBe('time_off_reviewed');
    expect(mail!.subject).toMatch(/^Your time off was approved: Vacation, /);
    expect(mail!.text).toContain('Enjoy!');

    expect((await priya.post(`/api/time-off/${vacation.id}/approve`)).status).toBe(403);
  });

  it('shows coworkers that someone is off, but not why', async () => {
    const own = await priya.get(`/api/team/schedule?from=${monday}&to=${day(6)}`);
    expect(own.body.timeOff[0]).toMatchObject({ typeName: 'Vacation', status: 'approved' });
    const coworker = await sam.get(`/api/team/schedule?from=${monday}&to=${day(6)}`);
    expect(coworker.body.timeOff[0]).toMatchObject({
      userId: people.priya!.id,
      typeName: null,
      typeColor: null,
    });
    const adminView = await admin.get(`/api/team/schedule?from=${monday}&to=${day(6)}`);
    expect(adminView.body.timeOff[0].typeName).toBe('Vacation');
  });

  it('shows time off in the schedule builder', async () => {
    const { body: schedules } = await admin.get('/api/schedules');
    const detail = await admin.get(`/api/schedules/${schedules[0].id}?from=${monday}&to=${day(6)}`);
    expect(detail.body.timeOff).toHaveLength(1);
    expect(detail.body.timeOff[0]).toMatchObject({
      typeName: 'Vacation',
      userId: people.priya!.id,
    });
  });

  it('lets people cancel upcoming time off, notifying admins when it was approved', async () => {
    const res = await priya.post(`/api/my/time-off/${vacation.id}/cancel`);
    expect(res.body.status).toBe('cancelled');
    const sent = await emails(ctx.db, { kind: 'time_off_cancelled' });
    expect(sent).toHaveLength(2);
    expect((await sam.post(`/api/my/time-off/${vacation.id}/cancel`)).status).toBe(404);
    expect((await priya.post(`/api/my/time-off/${vacation.id}/cancel`)).status).toBe(409);
  });

  it("doesn't email admins who turned time-off emails off", async () => {
    const second = ctx.agent();
    await login(second, people.second!.email);
    await second.patch('/api/me').send({ notifyTimeOff: false }).expect(200);
    const noa = ctx.agent();
    await login(noa, (await createUser(ctx.db, { name: 'Noa New' })).email);
    await clearEmails(ctx.db);
    await noa
      .post('/api/my/time-off')
      .send({ typeId: types['Personal Day']!.id, startDate: day(10), endDate: day(10) })
      .expect(201);
    const sent = await emails(ctx.db, { kind: 'time_off_requested' });
    expect(sent.map((e) => e.toEmail)).toEqual([people.admin!.email]);
    await second.patch('/api/me').send({ notifyTimeOff: true }).expect(200);
  });

  it('lets admins decline requests and change their mind', async () => {
    const { body: request } = await sam
      .post('/api/my/time-off')
      .send({ typeId: types['Personal Day']!.id, startDate: day(4), endDate: day(4) });
    const denied = await admin
      .post(`/api/time-off/${request.id}/deny`)
      .send({ note: 'Short-staffed that day' });
    expect(denied.body.status).toBe('denied');
    const [mail] = await emails(ctx.db, { to: people.sam!.email });
    expect(mail!.subject).toMatch(/^Your time off was declined: Personal Day/);
    const approved = await admin.post(`/api/time-off/${request.id}/approve`);
    expect(approved.body.status).toBe('approved');
  });

  it('lets admins record time off directly (already approved)', async () => {
    const res = await admin.post('/api/time-off').send({
      userId: people.sam!.id,
      typeId: types['Paid Holiday']!.id,
      startDate: day(10),
      endDate: day(10),
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('approved');
    const [mail] = await emails(ctx.db, { to: people.sam!.email });
    expect(mail!.subject).toMatch(/^Time off added: Paid Holiday/);
  });

  it('lists a person’s own requests', async () => {
    const mine = (await sam.get('/api/my/time-off')).body as TimeOffRequest[];
    expect(mine.map((r) => r.type.name)).toEqual(['Paid Holiday', 'Personal Day']);
    expect(mine.every((r) => r.userId === people.sam!.id)).toBe(true);
  });
});
