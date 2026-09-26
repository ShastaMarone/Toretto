import { addDays, formatDay } from '@shared/time';
import type { ShiftSwap, ShiftView, SwapOption } from '@shared/types';
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

// Swapping shifts: offer one to a coworker in your tier (optionally taking one
// of theirs), they accept, an admin approves, and the shifts change hands.

let ctx: TestContext;
let main: string;
let admin: Agent;
let ana: Agent;
let bo: Agent;
let cy: Agent;
let dee: Agent;
const people: Record<'admin' | 'ana' | 'bo' | 'cy' | 'dee', { id: string; email: string }> =
  {} as never;
const shifts: Record<string, string> = {};
let tier1: string;
let tier2: string;
const monday = nextMonday();
const day = (n: number) => addDays(monday, n);

async function publishShift(userId: string, n: number, start = '09:00', end = '17:00') {
  const res = await admin
    .post(`/api/schedules/${main}/shifts`)
    .send({ userId, ...shiftOn(day(n), start, end) })
    .expect(201);
  return res.body.id as string;
}
const publish = () => admin.post(`/api/schedules/${main}/publish`).send({}).expect(200);
const offer = (agent: Agent, body: Record<string, unknown>) =>
  agent.post('/api/my/swaps').send(body);
const ownerOf = async (id: string) =>
  (
    await ctx.db.query<{ userId: string; publishedUserId: string; status: string }>(
      `SELECT user_id AS "userId", published_user_id AS "publishedUserId", status
         FROM shifts WHERE id = $1`,
      [id],
    )
  ).rows[0]!;

beforeAll(async () => {
  ctx = await createTestContext();
  main = await defaultScheduleId(ctx.db);
  tier1 = await createTier(ctx.db, 'Tier 1');
  tier2 = await createTier(ctx.db, 'Tier 2');
  people.admin = await createUser(ctx.db, { name: 'Robin Admin', role: 'admin' });
  people.ana = await createUser(ctx.db, { name: 'Ana Ortiz', tierId: tier1 });
  people.bo = await createUser(ctx.db, { name: 'Bo Lee', tierId: tier1 });
  people.cy = await createUser(ctx.db, { name: 'Cy Diaz', tierId: tier1 });
  people.dee = await createUser(ctx.db, { name: 'Dee Kaur', tierId: tier2 });
  [admin, ana, bo, cy, dee] = [ctx.agent(), ctx.agent(), ctx.agent(), ctx.agent(), ctx.agent()];
  await login(admin, people.admin.email);
  await login(ana, people.ana.email);
  await login(bo, people.bo.email);
  await login(cy, people.cy.email);
  await login(dee, people.dee.email);

  shifts.anaMon = await publishShift(people.ana.id, 0);
  shifts.anaWed = await publishShift(people.ana.id, 2);
  shifts.anaFri = await publishShift(people.ana.id, 4);
  shifts.boTue = await publishShift(people.bo.id, 1);
  shifts.cyMon = await publishShift(people.cy.id, 0);
  shifts.deeThu = await publishShift(people.dee.id, 3);
  await publish();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(() => clearEmails(ctx.db));

describe('offering a shift', () => {
  it('suggests coworkers in the same tier, and says who is busy then', async () => {
    const res = await ana.get(`/api/my/swaps/options?shiftId=${shifts.anaMon}`);
    expect(res.status).toBe(200);
    const options = res.body as SwapOption[];
    expect(options.map((o) => [o.name, o.busy])).toEqual([
      ['Bo Lee', null],
      ['Cy Diaz', 'Working then'],
    ]);
    // Bo's Tuesday could be traded for it: Ana is free then.
    expect(options[0]!.shifts.map((s) => s.id)).toEqual([shifts.boTue]);
    // Only for your own shifts.
    expect((await bo.get(`/api/my/swaps/options?shiftId=${shifts.anaMon}`)).status).toBe(404);
  });

  it("won't offer a shift to someone in another tier, someone busy, or your own shift to yourself", async () => {
    // Someone invited who hasn't joined can't answer, so isn't offered.
    const invited = await createUser(ctx.db, { name: 'Ivy New', tierId: tier1, verified: false });
    expect((await offer(ana, { shiftId: shifts.anaMon, recipientId: invited.id })).status).toBe(
      400,
    );
    const otherTier = await offer(ana, { shiftId: shifts.anaMon, recipientId: people.dee.id });
    expect(otherTier.status).toBe(400);
    const busy = await offer(ana, { shiftId: shifts.anaMon, recipientId: people.cy.id });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('SWAP_BUSY');
    expect((await offer(ana, { shiftId: shifts.anaMon, recipientId: people.ana.id })).status).toBe(
      404,
    );
    expect((await offer(bo, { shiftId: shifts.anaMon, recipientId: people.cy.id })).status).toBe(
      404,
    );
  });

  it('asks the coworker by email, and only one swap per shift at a time', async () => {
    const res = await offer(ana, {
      shiftId: shifts.anaMon,
      recipientId: people.bo.id,
      note: 'Doctor appointment',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'pending',
      requester: { name: 'Ana Ortiz' },
      recipient: { name: 'Bo Lee' },
      shift: { id: shifts.anaMon, scheduleName: 'Main schedule' },
      returnShift: null,
      note: 'Doctor appointment',
    });
    const [mail] = await emails(ctx.db, { kind: 'swap_requested' });
    expect(mail!.toEmail).toBe(people.bo.email);
    expect(mail!.subject).toBe(`Ana Ortiz asked you to take their shift on ${formatDay(day(0))}`);
    expect(mail!.text).toContain('Doctor appointment');
    const again = await offer(ana, { shiftId: shifts.anaMon, recipientId: people.bo.id });
    expect(again.body.error.code).toBe('SWAP_EXISTS');
  });

  it('is only visible to the two people (and admins)', async () => {
    expect(((await bo.get('/api/my/swaps')).body as ShiftSwap[]).length).toBe(1);
    expect((await cy.get('/api/my/swaps')).body).toEqual([]);
    const [swap] = (await ana.get('/api/my/swaps')).body as ShiftSwap[];
    expect((await cy.post(`/api/my/swaps/${swap!.id}/accept`)).status).toBe(404);
    expect((await bo.post(`/api/my/swaps/${swap!.id}/cancel`)).status).toBe(404);
    expect((await ana.get('/api/swaps')).status).toBe(403);
  });

  it('tells the requester when the coworker declines', async () => {
    const [swap] = (await bo.get('/api/my/swaps')).body as ShiftSwap[];
    const res = await bo.post(`/api/my/swaps/${swap!.id}/decline`);
    expect(res.body.status).toBe('declined');
    const [mail] = await emails(ctx.db, { kind: 'swap_declined' });
    expect(mail).toMatchObject({
      toEmail: people.ana.email,
      subject: `Bo Lee can't take your shift on ${formatDay(day(0))}`,
    });
    expect((await ownerOf(shifts.anaMon)).publishedUserId).toBe(people.ana.id);
  });
});

describe('trading shifts', () => {
  let trade: ShiftSwap;

  it('asks admins once the coworker accepts, and changes nothing yet', async () => {
    trade = (
      await offer(ana, {
        shiftId: shifts.anaWed,
        recipientId: people.bo.id,
        returnShiftId: shifts.boTue,
      })
    ).body;
    expect(trade.returnShift?.id).toBe(shifts.boTue);
    const [ask] = await emails(ctx.db, { kind: 'swap_requested' });
    expect(ask!.subject).toBe('Ana Ortiz wants to swap shifts with you');
    // The coworker has to accept first.
    expect((await admin.post(`/api/swaps/${trade.id}/approve`)).status).toBe(409);
    const accepted = await bo.post(`/api/my/swaps/${trade.id}/accept`);
    expect(accepted.body.status).toBe('accepted');
    const [notice] = await emails(ctx.db, { kind: 'swap_accepted' });
    expect(notice).toMatchObject({
      toEmail: people.admin.email,
      subject: `Swap to approve: Ana Ortiz → Bo Lee, ${formatDay(day(2))}`,
    });
    const list = (await admin.get('/api/swaps')).body as ShiftSwap[];
    expect(list[0]).toMatchObject({ id: trade.id, status: 'accepted' });
    expect((await ownerOf(shifts.anaWed)).publishedUserId).toBe(people.ana.id);
  });

  it('swaps the shifts when an admin approves, already confirmed, and tells both', async () => {
    const res = await admin.post(`/api/swaps/${trade.id}/approve`).send({ note: 'Thanks both' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'approved', reviewedByName: 'Robin Admin' });
    expect(await ownerOf(shifts.anaWed)).toEqual({
      userId: people.bo.id,
      publishedUserId: people.bo.id,
      status: 'confirmed',
    });
    expect(await ownerOf(shifts.boTue)).toMatchObject({
      userId: people.ana.id,
      publishedUserId: people.ana.id,
    });
    const mail = await emails(ctx.db, { kind: 'swap_reviewed' });
    expect(Object.fromEntries(mail.map((m) => [m.toEmail, m.subject]))).toEqual({
      [people.ana.email]: `Swap approved: Bo Lee is taking your shift on ${formatDay(day(2))}`,
      [people.bo.email]: `Swap approved: you're working ${formatDay(day(2))}`,
    });
    // The team sees the new owners, and the schedule has nothing to publish.
    const team = await cy.get(`/api/team/schedule?from=${day(0)}&to=${day(6)}`);
    const byId = new Map((team.body.shifts as ShiftView[]).map((s) => [s.id, s.userId]));
    expect(byId.get(shifts.anaWed)).toBe(people.bo.id);
    expect(byId.get(shifts.boTue)).toBe(people.ana.id);
    const builder = await admin.get(`/api/schedules/${main}?from=${day(0)}&to=${day(6)}`);
    expect(builder.body.changes.total).toBe(0);
  });
});

describe('approving safely', () => {
  let swap: ShiftSwap;

  beforeAll(async () => {
    swap = (await offer(ana, { shiftId: shifts.anaFri, recipientId: people.bo.id })).body;
    await bo.post(`/api/my/swaps/${swap.id}/accept`).expect(200);
  });

  it('waits until unpublished edits to the shift are published or discarded', async () => {
    await admin
      .patch(`/api/shifts/${shifts.anaFri}`)
      .send(shiftOn(day(4), '10:00', '18:00'))
      .expect(200);
    const blocked = await admin.post(`/api/swaps/${swap.id}/approve`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('SWAP_UNPUBLISHED');
    await admin.post(`/api/schedules/${main}/discard-changes`).send({}).expect(200);
  });

  it("won't double-book the coworker", async () => {
    const clash = await admin
      .post(`/api/schedules/${main}/shifts`)
      .send({ userId: people.bo.id, ...shiftOn(day(4), '12:00', '14:00') })
      .expect(201);
    const blocked = await admin.post(`/api/swaps/${swap.id}/approve`);
    expect(blocked.body.error.code).toBe('SWAP_BUSY');
    await admin.delete(`/api/shifts/${clash.body.id}`).expect(200);
    expect((await admin.post(`/api/swaps/${swap.id}/approve`)).body.status).toBe('approved');
    expect((await ownerOf(shifts.anaFri)).publishedUserId).toBe(people.bo.id);
  });
});

describe('withdrawing, declining and expiring', () => {
  it('lets the requester withdraw, telling the coworker', async () => {
    const swap = (await offer(ana, { shiftId: shifts.boTue, recipientId: people.cy.id })).body;
    const res = await ana.post(`/api/my/swaps/${swap.id}/cancel`);
    expect(res.body.status).toBe('cancelled');
    const [mail] = await emails(ctx.db, { kind: 'swap_cancelled' });
    expect(mail).toMatchObject({
      toEmail: people.cy.email,
      subject: 'Ana Ortiz withdrew their swap request',
    });
    expect((await ana.post(`/api/my/swaps/${swap.id}/cancel`)).status).toBe(409);
  });

  it('lets admins decline, even before the coworker answers', async () => {
    const swap = (await offer(ana, { shiftId: shifts.boTue, recipientId: people.cy.id })).body;
    const res = await admin.post(`/api/swaps/${swap.id}/deny`).send({ note: 'Cy is training' });
    expect(res.body).toMatchObject({ status: 'denied', reviewNote: 'Cy is training' });
    const mail = await emails(ctx.db, { kind: 'swap_reviewed' });
    expect(mail.map((m) => m.toEmail).sort()).toEqual([people.ana.email, people.cy.email].sort());
    expect(mail[0]!.subject).toBe(`Swap declined: ${formatDay(day(1))}`);
  });

  it('expires once the shift starts', async () => {
    const person = await createUser(ctx.db, { name: 'Eve Park', tierId: tier2 });
    const eve = ctx.agent();
    await login(eve, person.email);
    const pending = (await offer(dee, { shiftId: shifts.deeThu, recipientId: person.id })).body;
    expect(pending.status).toBe('pending');
    await ctx.db.query(
      `UPDATE shifts SET start_time = now() - interval '1 hour',
                         published_start_time = now() - interval '1 hour'
        WHERE id = $1`,
      [shifts.deeThu],
    );
    const [mine] = (await eve.get('/api/my/swaps')).body as ShiftSwap[];
    expect(mine!.status).toBe('expired');
    expect((await eve.post(`/api/my/swaps/${pending.id}/accept`)).status).toBe(409);
  });
});
