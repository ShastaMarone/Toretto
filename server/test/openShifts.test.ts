import { addDays, formatDay } from '@shared/time';
import type { OpenShift, ShiftView } from '@shared/types';
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
  type Agent,
  type TestContext,
} from './helpers';

// Open shifts: an admin posts one for a tier, the first person in it to pick
// it up holds it, and an admin approves (it becomes their shift) or declines.

let ctx: TestContext;
let main: string;
let tier1: string;
let chatQueue: string;
let escalations: string;
let admin: Agent;
let ana: Agent;
let bo: Agent;
let dee: Agent;
const people: Record<'admin' | 'ana' | 'bo' | 'dee', { id: string; email: string }> = {} as never;
const monday = nextMonday();
const day = (n: number) => addDays(monday, n);

const post = (body: Record<string, unknown>) => admin.post('/api/open-shifts').send(body);
const mine = async (agent: Agent) => (await agent.get('/api/my/open-shifts')).body as OpenShift[];

beforeAll(async () => {
  ctx = await createTestContext();
  main = await defaultScheduleId(ctx.db);
  tier1 = await createTier(ctx.db, 'Tier 1');
  const tier2 = await createTier(ctx.db, 'Tier 2');
  chatQueue = await createLabel(ctx.db, 'Chat Queue', tier1);
  escalations = await createLabel(ctx.db, 'Escalations', tier2);
  people.admin = await createUser(ctx.db, { name: 'Robin Admin', role: 'admin' });
  people.ana = await createUser(ctx.db, { name: 'Ana Ortiz', tierId: tier1 });
  people.bo = await createUser(ctx.db, { name: 'Bo Lee', tierId: tier1 });
  people.dee = await createUser(ctx.db, { name: 'Dee Kaur', tierId: tier2 });
  // Invited but not joined yet: not emailed.
  await createUser(ctx.db, { name: 'Ivy New', tierId: tier1, verified: false });
  [admin, ana, bo, dee] = [ctx.agent(), ctx.agent(), ctx.agent(), ctx.agent()];
  await login(admin, people.admin.email);
  await login(ana, people.ana.email);
  await login(bo, people.bo.email);
  await login(dee, people.dee.email);
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(() => clearEmails(ctx.db));

describe('open shifts', () => {
  let open: OpenShift;

  it('are posted for a tier, emailing everyone in it', async () => {
    const res = await post({
      tierId: tier1,
      labelId: chatQueue,
      ...shiftOn(day(1)),
      notes: 'Covering for Cy',
    });
    expect(res.status).toBe(201);
    open = res.body;
    expect(open).toMatchObject({
      status: 'open',
      scheduleName: 'Main schedule',
      tier: { name: 'Tier 1' },
      label: { name: 'Chat Queue' },
      notes: 'Covering for Cy',
      claimedBy: null,
    });
    const sent = await emails(ctx.db, { kind: 'open_shift_posted' });
    expect(sent.map((e) => e.toEmail).sort()).toEqual([people.ana.email, people.bo.email].sort());
    expect(sent[0]!.subject).toBe(`Open shift on ${formatDay(day(1))}: can you take it?`);
  });

  it("can't be posted with another tier's label, in the past, or by team members", async () => {
    expect((await post({ tierId: tier1, labelId: escalations, ...shiftOn(day(2)) })).status).toBe(
      400,
    );
    const past = shiftOn(addDays(monday, -14));
    expect((await post({ tierId: tier1, ...past })).status).toBe(400);
    const { startTime } = shiftOn(day(2));
    const tooLong = { startTime, endTime: shiftOn(day(3), '10:00', '11:00').startTime };
    expect((await post({ tierId: tier1, ...tooLong })).status).toBe(400);
    expect(
      (await ana.post('/api/open-shifts').send({ tierId: tier1, ...shiftOn(day(2)) })).status,
    ).toBe(403);
  });

  it('show only to people in the tier', async () => {
    expect((await mine(ana)).map((o) => [o.id, o.busy])).toEqual([[open.id, null]]);
    expect(await mine(dee)).toEqual([]);
    expect((await dee.post(`/api/my/open-shifts/${open.id}/claim`)).status).toBe(404);
  });

  it('go to the first person to pick them up, pending an admin', async () => {
    const res = await ana.post(`/api/my/open-shifts/${open.id}/claim`);
    expect(res.body).toMatchObject({ status: 'claimed', claimedBy: { name: 'Ana Ortiz' } });
    const [notice] = await emails(ctx.db, { kind: 'open_shift_claimed' });
    expect(notice).toMatchObject({
      toEmail: people.admin.email,
      subject: `Ana Ortiz picked up the open shift on ${formatDay(day(1))}`,
    });
    const late = await bo.post(`/api/my/open-shifts/${open.id}/claim`);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OPEN_SHIFT_TAKEN');
    expect(await mine(bo)).toEqual([]);
    expect((await mine(ana))[0]).toMatchObject({ id: open.id, status: 'claimed' });
  });

  it('can be let go before an admin decides', async () => {
    expect((await ana.post(`/api/my/open-shifts/${open.id}/release`)).body.status).toBe('open');
    expect((await bo.post(`/api/my/open-shifts/${open.id}/release`)).status).toBe(404);
    await ana.post(`/api/my/open-shifts/${open.id}/claim`).expect(200);
  });

  it('open up again when an admin declines, but not for that person', async () => {
    const res = await admin.post(`/api/open-shifts/${open.id}/deny`).send({ note: 'Training day' });
    expect(res.body).toMatchObject({ status: 'open', claimedBy: null });
    const [mail] = await emails(ctx.db, { kind: 'open_shift_reviewed' });
    expect(mail).toMatchObject({
      toEmail: people.ana.email,
      subject: `The open shift on ${formatDay(day(1))} wasn't approved for you`,
    });
    expect(mail!.text).toContain('Training day');
    expect(await mine(ana)).toEqual([]);
    const again = await ana.post(`/api/my/open-shifts/${open.id}/claim`);
    expect(again.body.error.code).toBe('OPEN_SHIFT_DECLINED');
    await bo.post(`/api/my/open-shifts/${open.id}/claim`).expect(200);
  });

  it('become a published, confirmed shift when approved', async () => {
    const res = await admin.post(`/api/open-shifts/${open.id}/approve`);
    expect(res.body.status).toBe('filled');
    const [mail] = await emails(ctx.db, { kind: 'open_shift_reviewed' });
    expect(mail).toMatchObject({
      toEmail: people.bo.email,
      subject: `You've got the shift on ${formatDay(day(1))}`,
    });
    const team = await dee.get(`/api/team/schedule?from=${day(0)}&to=${day(6)}`);
    const shift = (team.body.shifts as ShiftView[]).find((s) => s.userId === people.bo.id);
    expect(shift).toMatchObject({
      status: 'confirmed',
      label: { name: 'Chat Queue' },
      notes: 'Covering for Cy',
      ...shiftOn(day(1)),
    });
    const builder = await admin.get(`/api/schedules/${main}?from=${day(0)}&to=${day(6)}`);
    expect(builder.body.changes.total).toBe(0);
    expect((await admin.post(`/api/open-shifts/${open.id}/approve`)).status).toBe(409);
  });

  it("won't double-book anyone", async () => {
    await admin
      .post(`/api/schedules/${main}/shifts`)
      .send({ userId: people.ana.id, ...shiftOn(day(3), '10:00', '14:00') })
      .expect(201);
    await admin.post(`/api/schedules/${main}/publish`).send({}).expect(200);
    const busy: OpenShift = (await post({ tierId: tier1, ...shiftOn(day(3)) })).body;
    expect((await mine(ana)).find((o) => o.id === busy.id)?.busy).toBe('Working then');
    const tried = await ana.post(`/api/my/open-shifts/${busy.id}/claim`);
    expect(tried.body.error).toMatchObject({
      code: 'OPEN_SHIFT_BUSY',
      message: 'You already have a shift then',
    });
    await bo.post(`/api/my/open-shifts/${busy.id}/claim`).expect(200);
    // Scheduled meanwhile (as a draft): approving would double-book Bo.
    const clash = await admin
      .post(`/api/schedules/${main}/shifts`)
      .send({ userId: people.bo.id, ...shiftOn(day(3), '16:00', '18:00') })
      .expect(201);
    const blocked = await admin.post(`/api/open-shifts/${busy.id}/approve`);
    expect(blocked.body.error.message).toBe('Bo Lee already has a shift then');
    await admin.delete(`/api/shifts/${clash.body.id}`).expect(200);
    // Cancelled instead, and Bo is told.
    const cancelled = await admin.post(`/api/open-shifts/${busy.id}/cancel`);
    expect(cancelled.body.status).toBe('cancelled');
    const [mail] = await emails(ctx.db, { kind: 'open_shift_cancelled' });
    expect(mail).toMatchObject({
      toEmail: people.bo.email,
      subject: `The open shift on ${formatDay(day(3))} was cancelled`,
    });
    expect((await bo.post(`/api/my/open-shifts/${busy.id}/claim`)).status).toBe(409);
  });

  it('expire once they start', async () => {
    const soon: OpenShift = (await post({ tierId: tier1, ...shiftOn(day(5)) })).body;
    await ctx.db.query(
      `UPDATE open_shifts SET start_time = now() - interval '1 hour' WHERE id = $1`,
      [soon.id],
    );
    const list = (await admin.get('/api/open-shifts')).body as OpenShift[];
    expect(list.find((o) => o.id === soon.id)?.status).toBe('expired');
    expect((await bo.post(`/api/my/open-shifts/${soon.id}/claim`)).status).toBe(409);
  });
});
