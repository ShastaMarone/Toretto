import { addDays, formatTimeRange, localDate, localTime } from '@shared/time';
import type { BuilderShift, ScheduleDetail, ShiftView } from '@shared/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearEmails,
  createLabel,
  createTestContext,
  createTier,
  createUser,
  emails,
  login,
  nextMonday,
  shiftOn,
  TZ,
  type Agent,
  type TestContext,
} from './helpers';

let ctx: TestContext;
let admin: Agent;
let ana: Agent;
let ben: Agent;
let tier1: string;
let tier2: string;
let tier1Label: string;
let tier2Label: string;
let globalLabel: string;
const people: Record<string, { id: string; email: string }> = {};
const monday = nextMonday();
const day = (n: number) => addDays(monday, n);

beforeAll(async () => {
  ctx = await createTestContext();
  tier1 = await createTier(ctx.db, 'Tier 1');
  tier2 = await createTier(ctx.db, 'Tier 2', '#0891b2');
  tier1Label = await createLabel(ctx.db, 'Chat Queue', tier1);
  tier2Label = await createLabel(ctx.db, 'Escalations', tier2);
  globalLabel = await createLabel(ctx.db, 'On-Call', null);
  people.admin = await createUser(ctx.db, { name: 'Robin Admin', role: 'admin' });
  people.ana = await createUser(ctx.db, { name: 'Ana Ortiz', tierId: tier1 });
  people.ben = await createUser(ctx.db, {
    name: 'Ben Park',
    tierId: tier1,
    timezone: 'America/Vancouver',
  });
  people.cy = await createUser(ctx.db, { name: 'Cy Tran', tierId: tier2 });
  admin = ctx.agent();
  ana = ctx.agent();
  ben = ctx.agent();
  await login(admin, people.admin!.email);
  await login(ana, people.ana!.email);
  await login(ben, people.ben!.email);
});
afterAll(async () => {
  await ctx.close();
});

async function detail(id: string): Promise<ScheduleDetail> {
  const res = await admin.get(`/api/schedules/${id}`);
  expect(res.status).toBe(200);
  return res.body;
}

async function addShift(
  scheduleId: string,
  userId: string,
  date: string,
  opts: { start?: string; end?: string; labelId?: string | null; notes?: string } = {},
): Promise<BuilderShift> {
  const res = await admin.post(`/api/schedules/${scheduleId}/shifts`).send({
    userId,
    labelId: opts.labelId ?? null,
    notes: opts.notes ?? null,
    ...shiftOn(date, opts.start, opts.end),
  });
  expect(res.status, res.text).toBe(201);
  return res.body;
}

async function myShifts(agent: Agent): Promise<ShiftView[]> {
  const res = await agent.get(`/api/my/shifts?from=${monday}&to=${day(6)}`);
  expect(res.status).toBe(200);
  return res.body;
}

describe('schedules', () => {
  let scheduleId: string;

  it('creates a draft schedule per tier and prevents overlaps', async () => {
    const res = await admin
      .post('/api/schedules')
      .send({ tierId: tier1, startDate: monday, endDate: day(6) });
    expect(res.status).toBe(201);
    expect(res.body.schedule).toMatchObject({ status: 'draft', tierName: 'Tier 1', shiftCount: 0 });
    scheduleId = res.body.schedule.id;

    const overlap = await admin
      .post('/api/schedules')
      .send({ tierId: tier1, startDate: day(3), endDate: day(9) });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('SCHEDULE_OVERLAP');

    const otherTier = await admin
      .post('/api/schedules')
      .send({ tierId: tier2, startDate: monday, endDate: day(6) });
    expect(otherTier.status).toBe(201);

    const tooLong = await admin
      .post('/api/schedules')
      .send({ tierId: tier1, startDate: day(30), endDate: day(90) });
    expect(tooLong.status).toBe(400);
  });

  it('validates shifts', async () => {
    const ok = await addShift(scheduleId, people.ana!.id, monday, { labelId: tier1Label });
    expect(ok.changeState).toBe('new');
    expect(ok.published).toBeNull();

    const outside = await admin
      .post(`/api/schedules/${scheduleId}/shifts`)
      .send({ userId: people.ana!.id, ...shiftOn(day(8)) });
    expect(outside.status).toBe(400);

    const overlapping = await admin
      .post(`/api/schedules/${scheduleId}/shifts`)
      .send({ userId: people.ana!.id, ...shiftOn(monday, '16:00', '20:00') });
    expect(overlapping.status).toBe(409);
    expect(overlapping.body.error.code).toBe('SHIFT_OVERLAP');
    expect(overlapping.body.error.message).toContain('Ana Ortiz already has a Tier 1 shift');

    const wrongLabel = await admin
      .post(`/api/schedules/${scheduleId}/shifts`)
      .send({ userId: people.ana!.id, labelId: tier2Label, ...shiftOn(day(1)) });
    expect(wrongLabel.status).toBe(400);

    const backwards = await admin.post(`/api/schedules/${scheduleId}/shifts`).send({
      userId: people.ana!.id,
      startTime: shiftOn(day(1)).endTime,
      endTime: shiftOn(day(1)).startTime,
    });
    expect(backwards.status).toBe(400);

    // Overnight shift ending the next morning is fine.
    const night = await addShift(scheduleId, people.ben!.id, day(1), {
      start: '22:00',
      end: '06:00',
      labelId: globalLabel,
    });
    expect(Date.parse(night.endTime) - Date.parse(night.startTime)).toBe(8 * 3_600_000);
  });

  it('keeps drafts invisible to the team', async () => {
    expect(await myShifts(ana)).toEqual([]);
    const team = await ana.get(`/api/team/schedule?from=${monday}&to=${day(6)}`);
    expect(team.body.shifts).toEqual([]);
    expect((await ana.get('/api/schedules')).status).toBe(403);
    expect((await ana.post(`/api/schedules/${scheduleId}/publish`)).status).toBe(403);
  });

  it('refuses date changes that would strand shifts', async () => {
    const res = await admin.patch(`/api/schedules/${scheduleId}`).send({ startDate: day(1) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SHIFTS_OUTSIDE_RANGE');
    const renamed = await admin.patch(`/api/schedules/${scheduleId}`).send({ name: 'Launch week' });
    expect(renamed.body.name).toBe('Launch week');
  });
});

describe('publish → notify → confirm', () => {
  let scheduleId: string;
  const shifts: Record<string, BuilderShift> = {};

  beforeAll(async () => {
    await clearEmails(ctx.db);
    const res = await admin
      .post('/api/schedules')
      .send({ tierId: tier1, startDate: day(14), endDate: day(20) });
    scheduleId = res.body.schedule.id;
    shifts.anaMon = await addShift(scheduleId, people.ana!.id, day(14), { labelId: tier1Label });
    shifts.anaTue = await addShift(scheduleId, people.ana!.id, day(15), { notes: 'Bring headset' });
    shifts.anaFri = await addShift(scheduleId, people.ana!.id, day(18));
    shifts.benTue = await addShift(scheduleId, people.ben!.id, day(15), {
      start: '12:00',
      end: '20:00',
    });
  });

  it('publishes and emails each person once with all of their shifts', async () => {
    const res = await admin.post(`/api/schedules/${scheduleId}/publish`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ added: 4, updated: 0, removed: 0, unchanged: 0, emailsQueued: 2 });
    expect(ctx.kicks()).toBeGreaterThan(0);

    const [anaMail, ...more] = await emails(ctx.db, { to: people.ana!.email });
    expect(more).toHaveLength(0);
    expect(anaMail!.kind).toBe('schedule_published');
    expect(anaMail!.subject).toMatch(/^Your Tier 1 schedule for .+ is ready$/);
    expect(anaMail!.shiftIds.sort()).toEqual(
      [shifts.anaMon!.id, shifts.anaTue!.id, shifts.anaFri!.id].sort(),
    );
    for (const s of [shifts.anaMon!, shifts.anaTue!, shifts.anaFri!]) {
      expect(anaMail!.text).toContain(`http://localhost:5173/confirm-shift/${s.id}`);
    }
    expect(anaMail!.text).toContain(`http://localhost:5173/confirm-shifts/${scheduleId}`);
    expect(anaMail!.text).toContain('Chat Queue');
    expect(anaMail!.text).toContain('Note: Bring headset');

    // Ben's email uses his own time zone.
    const [benMail] = await emails(ctx.db, { to: people.ben!.email });
    expect(benMail!.text).toContain(
      formatTimeRange(shifts.benTue!.startTime, shifts.benTue!.endTime, 'America/Vancouver'),
    );
    expect(benMail!.text).toContain('(America/Vancouver)');

    const summary = (await detail(scheduleId)).schedule;
    expect(summary).toMatchObject({
      status: 'published',
      pendingCount: 4,
      confirmedCount: 0,
      pendingChanges: 0,
    });
  });

  it('shows published shifts to the team as pending until confirmed', async () => {
    const mine = (await ana.get(`/api/my/shifts?from=${day(14)}&to=${day(20)}`))
      .body as ShiftView[];
    expect(mine.map((s) => s.status)).toEqual(['pending', 'pending', 'pending']);
    expect(mine[0]!.label).toMatchObject({ name: 'Chat Queue' });
    expect(mine[0]!.tier).toMatchObject({ name: 'Tier 1' });

    const confirmed = await ana.post(`/api/my/shifts/${shifts.anaMon!.id}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('confirmed');
    // Confirming twice is harmless.
    expect((await ana.post(`/api/my/shifts/${shifts.anaMon!.id}/confirm`)).status).toBe(200);

    // Nobody can confirm someone else's shift.
    expect((await ben.post(`/api/my/shifts/${shifts.anaTue!.id}/confirm`)).status).toBe(404);

    const all = await ana.post('/api/my/shifts/confirm').send({ scheduleId });
    expect(all.body.confirmed).toBe(2);

    const team = await ben.get(`/api/team/schedule?from=${day(14)}&to=${day(20)}&tierId=${tier1}`);
    expect(team.body.shifts).toHaveLength(4);
    expect(team.body.people.map((p: { name: string }) => p.name)).toEqual([
      'Ana Ortiz',
      'Ben Park',
    ]);

    const audit = await ctx.db.query(
      `SELECT action FROM audit_log WHERE action LIKE 'shift.confirmed%' ORDER BY id`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['shift.confirmed', 'shift.confirmed_all']);
  });

  it('re-publishing only notifies people whose shifts changed', async () => {
    await clearEmails(ctx.db);
    // Ana's Monday moves an hour (needs re-confirmation), her Tuesday note changes (doesn't),
    // her Friday is reassigned to Ben, Ben's Tuesday is deleted and he gets a new Thursday.
    await admin
      .patch(`/api/shifts/${shifts.anaMon!.id}`)
      .send(shiftOn(day(14), '10:00', '18:00'))
      .expect(200);
    await admin
      .patch(`/api/shifts/${shifts.anaTue!.id}`)
      .send({ notes: 'Bring headset and badge' })
      .expect(200);
    await admin
      .patch(`/api/shifts/${shifts.anaFri!.id}`)
      .send({ userId: people.ben!.id })
      .expect(200);
    const del = await admin.delete(`/api/shifts/${shifts.benTue!.id}`);
    expect(del.body).toEqual({ pendingRemoval: true });
    const benThu = await addShift(scheduleId, people.ben!.id, day(17));

    // Until publishing, the team still sees the old version.
    const anaView = (await ana.get(`/api/my/shifts?from=${day(14)}&to=${day(20)}`))
      .body as ShiftView[];
    expect(anaView.find((s) => s.id === shifts.anaMon!.id)!.startTime).toBe(
      shifts.anaMon!.startTime,
    );
    expect(anaView).toHaveLength(3);
    const benView = (await ben.get(`/api/my/shifts?from=${day(14)}&to=${day(20)}`))
      .body as ShiftView[];
    expect(benView.map((s) => s.id)).toEqual([shifts.benTue!.id]);

    const d = await detail(scheduleId);
    expect(d.changes).toEqual({ added: 1, updated: 3, removed: 1, total: 5 });
    expect(d.removedShifts.map((s) => s.id)).toEqual([shifts.benTue!.id]);
    expect(d.shifts.find((s) => s.id === benThu.id)!.changeState).toBe('new');

    const res = await admin.post(`/api/schedules/${scheduleId}/publish`);
    expect(res.body).toEqual({ added: 1, updated: 3, removed: 1, unchanged: 0, emailsQueued: 2 });

    const [anaMail] = await emails(ctx.db, { to: people.ana!.email });
    expect(anaMail!.kind).toBe('schedule_updated');
    expect(anaMail!.subject).toMatch(/^Schedule updated: Tier 1, /);
    expect(anaMail!.text).toContain('CHANGED SHIFTS');
    expect(anaMail!.text).toContain('CANCELLED SHIFTS'); // Friday went to Ben
    expect(anaMail!.text).toContain(`confirm-shift/${shifts.anaMon!.id}`);
    expect(anaMail!.text).not.toContain(`confirm-shift/${shifts.anaTue!.id}`); // note-only, still confirmed

    const [benMail] = await emails(ctx.db, { to: people.ben!.email });
    expect(benMail!.text).toContain('NEW SHIFTS');
    expect(benMail!.text).toContain(`confirm-shift/${shifts.anaFri!.id}`);
    expect(benMail!.text).toContain(`confirm-shift/${benThu.id}`);
    expect(benMail!.text).toContain('CANCELLED SHIFTS');

    const after = (await ana.get(`/api/my/shifts?from=${day(14)}&to=${day(20)}`))
      .body as ShiftView[];
    expect(after.map((s) => [s.id, s.status])).toEqual([
      [shifts.anaMon!.id, 'pending'],
      [shifts.anaTue!.id, 'confirmed'],
    ]);
    expect(after[1]!.notes).toBe('Bring headset and badge');
    const benAfter = (await ben.get(`/api/my/shifts?from=${day(14)}&to=${day(20)}`))
      .body as ShiftView[];
    expect(benAfter.map((s) => s.id)).toEqual([benThu.id, shifts.anaFri!.id]);

    // Publishing again with no edits sends nothing.
    await clearEmails(ctx.db);
    const noop = await admin.post(`/api/schedules/${scheduleId}/publish`);
    expect(noop.body).toMatchObject({ added: 0, updated: 0, removed: 0, emailsQueued: 0 });
    expect(await emails(ctx.db)).toHaveLength(0);
  });

  it('can discard unpublished edits', async () => {
    await admin
      .patch(`/api/shifts/${shifts.anaMon!.id}`)
      .send(shiftOn(day(14), '07:00', '15:00'))
      .expect(200);
    await admin.delete(`/api/shifts/${shifts.anaTue!.id}`).expect(200);
    const extra = await addShift(scheduleId, people.ana!.id, day(19));
    expect((await detail(scheduleId)).changes.total).toBe(3);

    const res = await admin.post(`/api/schedules/${scheduleId}/discard-changes`);
    expect(res.status).toBe(200);
    expect(res.body.changes.total).toBe(0);
    const ids = (res.body as ScheduleDetail).shifts.map((s) => s.id);
    expect(ids).toContain(shifts.anaTue!.id);
    expect(ids).not.toContain(extra.id);
    expect(res.body.shifts.find((s: BuilderShift) => s.id === shifts.anaMon!.id).startTime).toBe(
      shiftOn(day(14), '10:00', '18:00').startTime,
    );
  });

  it('restores a shift that was marked for removal', async () => {
    await admin.delete(`/api/shifts/${shifts.anaTue!.id}`).expect(200);
    const restored = await admin.post(`/api/shifts/${shifts.anaTue!.id}/restore`);
    expect(restored.body.changeState).toBe('unchanged');
  });

  it('copies a schedule into a later week', async () => {
    const res = await admin.post('/api/schedules').send({
      tierId: tier1,
      startDate: day(21),
      endDate: day(27),
      copyFromScheduleId: scheduleId,
    });
    expect(res.status).toBe(201);
    expect(res.body.copied).toBe(4);
    const copy = await detail(res.body.schedule.id);
    expect(copy.schedule.status).toBe('draft');
    // Same wall-clock times, one week later (even across a DST change).
    const local = (iso: string, plusDays = 0) =>
      `${addDays(localDate(iso, TZ), plusDays)} ${localTime(iso, TZ)}`;
    const originals = (await detail(scheduleId)).shifts.map((s) => local(s.startTime, 7)).sort();
    expect(copy.shifts.map((s) => local(s.startTime)).sort()).toEqual(originals);
  });

  it('tells everyone when a published schedule is deleted', async () => {
    await clearEmails(ctx.db);
    const res = await admin.delete(`/api/schedules/${scheduleId}`);
    expect(res.body).toEqual({ notified: 2 });
    const [cancel] = await emails(ctx.db, { to: people.ana!.email });
    expect(cancel!.kind).toBe('schedule_cancelled');
    expect(cancel!.subject).toMatch(/^Shifts cancelled: Tier 1, /);
    expect((await ana.get(`/api/my/shifts?from=${day(14)}&to=${day(20)}`)).body).toEqual([]);
  });
});

describe('time zones', () => {
  it('returns member views in the viewer’s zone', async () => {
    const res = await admin
      .post('/api/schedules')
      .send({ tierId: tier2, startDate: day(35), endDate: day(41) });
    const id = res.body.schedule.id;
    // 11pm Toronto on Monday is 8pm Monday in Vancouver.
    await addShift(id, people.cy!.id, day(35), { start: '23:00', end: '23:30' });
    await admin.post(`/api/schedules/${id}/publish`).expect(200);
    const van = ctx.agent();
    await ctx.db.query(`UPDATE users SET timezone = 'America/Vancouver' WHERE id = $1`, [
      people.cy!.id,
    ]);
    await login(van, people.cy!.email);
    const mondayOnly = await van.get(`/api/my/shifts?from=${day(35)}&to=${day(35)}`);
    expect(mondayOnly.body).toHaveLength(1);
    await ctx.db.query(`UPDATE users SET timezone = 'Europe/London' WHERE id = $1`, [
      people.cy!.id,
    ]);
    const london = await van.get(`/api/my/shifts?from=${day(35)}&to=${day(35)}`);
    expect(london.body).toHaveLength(0); // already Tuesday in London
    expect(TZ).toBe('America/Toronto');
  });
});
