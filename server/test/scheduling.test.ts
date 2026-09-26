import { addDays, formatTimeRange, localDate, localTime } from '@shared/time';
import type { BuilderShift, ScheduleRange, ScheduleSummary, ShiftView } from '@shared/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

let ctx: TestContext;
let admin: Agent;
let ana: Agent;
let ben: Agent;
let main: string;
let tier1: string;
let tier2: string;
let tier1Label: string;
let tier2Label: string;
let globalLabel: string;
const people: Record<string, { id: string; email: string }> = {};
const monday = nextMonday();
const day = (n: number) => addDays(monday, n);
const week = (n: number) => ({ from: day(n * 7), to: day(n * 7 + 6) });

beforeAll(async () => {
  ctx = await createTestContext();
  main = await defaultScheduleId(ctx.db);
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
  await ctx.db.query(`UPDATE users SET time_format = '24h' WHERE id = $1`, [people.cy.id]);
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

async function builder(id: string, range: { from: string; to: string }): Promise<ScheduleRange> {
  const res = await admin.get(`/api/schedules/${id}?from=${range.from}&to=${range.to}`);
  expect(res.status, res.text).toBe(200);
  return res.body;
}

async function addShift(
  userId: string,
  date: string,
  opts: {
    start?: string;
    end?: string;
    labelId?: string | null;
    notes?: string;
    scheduleId?: string;
  } = {},
): Promise<BuilderShift> {
  const res = await admin.post(`/api/schedules/${opts.scheduleId ?? main}/shifts`).send({
    userId,
    labelId: opts.labelId ?? null,
    notes: opts.notes ?? null,
    ...shiftOn(date, opts.start, opts.end),
  });
  expect(res.status, res.text).toBe(201);
  return res.body;
}

async function publish(range?: { from: string; to: string }, id = main) {
  const res = await admin.post(`/api/schedules/${id}/publish`).send(range ?? {});
  expect(res.status, res.text).toBe(200);
  return res.body;
}

async function mine(agent: Agent, from: string, to: string): Promise<ShiftView[]> {
  const res = await agent.get(`/api/my/shifts?from=${from}&to=${to}`);
  expect(res.status).toBe(200);
  return res.body;
}

describe('schedules', () => {
  it('starts with one main schedule and lets admins add more', async () => {
    const list = (await admin.get('/api/schedules')).body as ScheduleSummary[];
    expect(list).toMatchObject([{ id: main, name: 'Main schedule', isDefault: true }]);

    const extra = await admin.post('/api/schedules').send({ name: 'Holiday coverage' });
    expect(extra.status).toBe(201);
    expect(extra.body).toMatchObject({ name: 'Holiday coverage', isDefault: false });
    const dup = await admin.post('/api/schedules').send({ name: 'holiday COVERAGE' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('NAME_TAKEN');
    const renamed = await admin
      .patch(`/api/schedules/${extra.body.id}`)
      .send({ name: 'Weekend coverage' });
    expect(renamed.body.name).toBe('Weekend coverage');
    expect((await admin.delete(`/api/schedules/${main}`)).status).toBe(400);
    expect((await admin.delete(`/api/schedules/${extra.body.id}`)).body).toEqual({ notified: 0 });
  });

  it('shows everyone, from every tier, for any range of days', async () => {
    const b = await builder(main, week(0));
    expect(b.people.map((p) => p.name)).toEqual([
      'Ana Ortiz',
      'Ben Park',
      'Cy Tran',
      'Robin Admin',
    ]);
    expect(b.labels.map((l) => l.name).sort()).toEqual(['Chat Queue', 'Escalations', 'On-Call']);
    const tooLong = await admin.get(`/api/schedules/${main}?from=${day(0)}&to=${day(90)}`);
    expect(tooLong.status).toBe(400);
  });

  it('validates shifts', async () => {
    const ok = await addShift(people.ana!.id, monday, { labelId: tier1Label });
    expect(ok.changeState).toBe('new');
    expect(ok.published).toBeNull();
    // Any date works: the calendar is open-ended.
    await addShift(people.cy!.id, day(200), { labelId: tier2Label });

    const overlapping = await admin
      .post(`/api/schedules/${main}/shifts`)
      .send({ userId: people.ana!.id, ...shiftOn(monday, '16:00', '20:00') });
    expect(overlapping.status).toBe(409);
    expect(overlapping.body.error.code).toBe('SHIFT_OVERLAP');
    expect(overlapping.body.error.message).toContain('Ana Ortiz already has a shift');

    const wrongLabel = await admin
      .post(`/api/schedules/${main}/shifts`)
      .send({ userId: people.ana!.id, labelId: tier2Label, ...shiftOn(day(1)) });
    expect(wrongLabel.status).toBe(400);
    expect(wrongLabel.body.error.message).toBe(
      "Escalations is a Tier 2 label, and Ana Ortiz isn't in Tier 2",
    );

    const backwards = await admin.post(`/api/schedules/${main}/shifts`).send({
      userId: people.ana!.id,
      startTime: shiftOn(day(1)).endTime,
      endTime: shiftOn(day(1)).startTime,
    });
    expect(backwards.status).toBe(400);

    // Overnight shift ending the next morning is fine.
    const night = await addShift(people.ben!.id, day(1), {
      start: '22:00',
      end: '06:00',
      labelId: globalLabel,
    });
    expect(Date.parse(night.endTime) - Date.parse(night.startTime)).toBe(8 * 3_600_000);
  });

  it('keeps drafts invisible to the team', async () => {
    expect(await mine(ana, day(0), day(6))).toEqual([]);
    const team = await ana.get(`/api/team/schedule?from=${day(0)}&to=${day(6)}`);
    expect(team.body.shifts).toEqual([]);
    expect((await ana.get('/api/schedules')).status).toBe(403);
    expect((await ana.post(`/api/schedules/${main}/publish`)).status).toBe(403);
    // Clean up for the next section.
    await admin.post(`/api/schedules/${main}/discard-changes`).send({}).expect(200);
    expect((await builder(main, week(0))).shifts).toEqual([]);
  });
});

describe('publish → notify → confirm', () => {
  const shifts: Record<string, BuilderShift> = {};

  beforeAll(async () => {
    await clearEmails(ctx.db);
    shifts.anaMon = await addShift(people.ana!.id, day(14), { labelId: tier1Label });
    shifts.anaTue = await addShift(people.ana!.id, day(15), { notes: 'Bring headset' });
    shifts.anaFri = await addShift(people.ana!.id, day(18));
    shifts.benTue = await addShift(people.ben!.id, day(15), { start: '12:00', end: '20:00' });
    shifts.cyWed = await addShift(people.cy!.id, day(16), { labelId: tier2Label });
    // The week after stays a draft.
    shifts.anaLater = await addShift(people.ana!.id, day(21));
  });

  it('publishes one week and emails each person once with all of their shifts', async () => {
    expect((await builder(main, week(2))).changes).toEqual({
      added: 5,
      updated: 0,
      removed: 0,
      total: 5,
    });
    const res = await publish(week(2));
    expect(res).toEqual({ added: 5, updated: 0, removed: 0, unchanged: 0, emailsQueued: 3 });
    expect(ctx.kicks()).toBeGreaterThan(0);

    const [anaMail, ...more] = await emails(ctx.db, { to: people.ana!.email });
    expect(more).toHaveLength(0);
    expect(anaMail!.kind).toBe('schedule_published');
    expect(anaMail!.subject).toMatch(/^Your schedule for .+ – .+$/);
    const ids = [shifts.anaMon!.id, shifts.anaTue!.id, shifts.anaFri!.id];
    expect(anaMail!.shiftIds.sort()).toEqual([...ids].sort());
    for (const id of ids)
      expect(anaMail!.text).toContain(`http://localhost:5173/confirm-shift/${id}`);
    expect(anaMail!.text).toContain(`http://localhost:5173/confirm-shifts?ids=${ids.join(',')}`);
    expect(anaMail!.text).not.toContain(shifts.anaLater!.id);
    expect(anaMail!.text).toContain('Chat Queue');
    expect(anaMail!.text).toContain('Note: Bring headset');
    // One schedule, so it isn't named.
    expect(anaMail!.text).not.toContain('Main schedule');

    // Ben's email uses his own time zone.
    const [benMail] = await emails(ctx.db, { to: people.ben!.email });
    expect(benMail!.text).toContain(
      formatTimeRange(shifts.benTue!.startTime, shifts.benTue!.endTime, 'America/Vancouver'),
    );
    expect(benMail!.text).toContain('(America/Vancouver)');
    // Cy reads 24-hour times.
    const [cyMail] = await emails(ctx.db, { to: people.cy!.email });
    expect(cyMail!.text).toContain('09:00 – 17:00');
    expect(anaMail!.text).toContain('9:00 AM – 5:00 PM');

    const summary = (await builder(main, week(2))).schedule;
    expect(summary.pendingChanges).toBe(1); // the draft the week after
    expect(summary.firstChangeDate).toBe(day(21));
    expect(summary.publishedAt).not.toBeNull();
    expect((await builder(main, week(2))).changes.total).toBe(0);
    expect(await mine(ana, day(21), day(27))).toEqual([]);
  });

  it('shows every tier to the team and tells admins about confirmations', async () => {
    const own = await mine(ana, day(14), day(20));
    expect(own.map((s) => s.status)).toEqual(['pending', 'pending', 'pending']);
    expect(own[0]!.label).toMatchObject({ name: 'Chat Queue' });
    expect(own[0]!.tier).toMatchObject({ name: 'Tier 1' });
    expect(own[0]!.scheduleName).toBe('Main schedule');

    const team = await ben.get(`/api/team/schedule?from=${day(14)}&to=${day(20)}`);
    expect(team.body.shifts).toHaveLength(5);
    expect(team.body.people.map((p: { name: string }) => p.name)).toEqual([
      'Ana Ortiz',
      'Ben Park',
      'Cy Tran',
    ]);
    expect(team.body.schedules).toEqual([{ id: main, name: 'Main schedule' }]);

    await clearEmails(ctx.db);
    const confirmed = await ana.post(`/api/my/shifts/${shifts.anaMon!.id}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('confirmed');
    // Confirming twice is harmless and doesn't email again.
    expect((await ana.post(`/api/my/shifts/${shifts.anaMon!.id}/confirm`)).status).toBe(200);
    const [notice, ...others] = await emails(ctx.db, { kind: 'shifts_confirmed' });
    expect(others).toHaveLength(0);
    expect(notice!.toEmail).toBe(people.admin!.email);
    expect(notice!.subject).toMatch(/^Ana Ortiz confirmed their shift on /);

    // Nobody can confirm someone else's shift.
    expect((await ben.post(`/api/my/shifts/${shifts.anaTue!.id}/confirm`)).status).toBe(404);
    const notMine = await ben
      .post('/api/my/shifts/confirm')
      .send({ shiftIds: [shifts.anaTue!.id] });
    expect(notMine.body.confirmed).toBe(0);

    // Admins who opt out aren't emailed.
    await admin.patch('/api/me').send({ notifyConfirmations: false }).expect(200);
    await clearEmails(ctx.db);
    const some = await ana.post('/api/my/shifts/confirm').send({ shiftIds: [shifts.anaTue!.id] });
    expect(some.body.confirmed).toBe(1);
    expect(await emails(ctx.db, { kind: 'shifts_confirmed' })).toHaveLength(0);
    await admin.patch('/api/me').send({ notifyConfirmations: true }).expect(200);

    const all = await ana.post('/api/my/shifts/confirm').send({});
    expect(all.body.confirmed).toBe(1);
    const [allNotice] = await emails(ctx.db, { kind: 'shifts_confirmed' });
    expect(allNotice!.subject).toMatch(/^Ana Ortiz confirmed their shift on /);

    const audit = await ctx.db.query(
      `SELECT action FROM audit_log WHERE action LIKE 'shift.confirmed%' ORDER BY id`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'shift.confirmed',
      'shift.confirmed',
      'shift.confirmed',
    ]);
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
    const benThu = await addShift(people.ben!.id, day(17));

    // Until publishing, the team still sees the old version.
    const anaView = await mine(ana, day(14), day(20));
    expect(anaView.find((s) => s.id === shifts.anaMon!.id)!.startTime).toBe(
      shifts.anaMon!.startTime,
    );
    expect(anaView).toHaveLength(3);
    expect((await mine(ben, day(14), day(20))).map((s) => s.id)).toEqual([shifts.benTue!.id]);

    const b = await builder(main, week(2));
    expect(b.changes).toEqual({ added: 1, updated: 3, removed: 1, total: 5 });
    expect(b.removedShifts.map((s) => s.id)).toEqual([shifts.benTue!.id]);
    expect(b.shifts.find((s) => s.id === benThu.id)!.changeState).toBe('new');

    const res = await publish(week(2));
    expect(res).toEqual({ added: 1, updated: 3, removed: 1, unchanged: 1, emailsQueued: 2 });

    const [anaMail] = await emails(ctx.db, { to: people.ana!.email });
    expect(anaMail!.kind).toBe('schedule_updated');
    expect(anaMail!.subject).toMatch(/^Schedule updated: /);
    expect(anaMail!.text).toContain('CHANGED SHIFTS');
    expect(anaMail!.text).toContain('CANCELLED SHIFTS'); // Friday went to Ben
    expect(anaMail!.text).toContain(`confirm-shift/${shifts.anaMon!.id}`);
    expect(anaMail!.text).not.toContain(`confirm-shift/${shifts.anaTue!.id}`); // note-only, still confirmed

    const [benMail] = await emails(ctx.db, { to: people.ben!.email });
    expect(benMail!.text).toContain('NEW SHIFTS');
    expect(benMail!.text).toContain(`confirm-shift/${shifts.anaFri!.id}`);
    expect(benMail!.text).toContain(`confirm-shift/${benThu.id}`);
    expect(benMail!.text).toContain('CANCELLED SHIFTS');

    const after = await mine(ana, day(14), day(20));
    expect(after.map((s) => [s.id, s.status])).toEqual([
      [shifts.anaMon!.id, 'pending'],
      [shifts.anaTue!.id, 'confirmed'],
    ]);
    expect(after[1]!.notes).toBe('Bring headset and badge');
    expect((await mine(ben, day(14), day(20))).map((s) => s.id)).toEqual([
      benThu.id,
      shifts.anaFri!.id,
    ]);

    // Publishing again with no edits sends nothing.
    await clearEmails(ctx.db);
    const noop = await publish(week(2));
    expect(noop).toMatchObject({ added: 0, updated: 0, removed: 0, emailsQueued: 0 });
    expect(await emails(ctx.db)).toHaveLength(0);
  });

  it('keeps a shift moved to another week visible where the team sees it', async () => {
    await admin
      .patch(`/api/shifts/${shifts.cyWed!.id}`)
      .send(shiftOn(day(30), '09:00', '17:00'))
      .expect(200);
    const from = await builder(main, week(2));
    expect(from.shifts.map((s) => s.id)).not.toContain(shifts.cyWed!.id);
    expect(from.removedShifts.map((s) => s.id)).toContain(shifts.cyWed!.id);
    expect(from.changes.updated).toBe(1);
    const to = await builder(main, week(4));
    expect(to.shifts.find((s) => s.id === shifts.cyWed!.id)!.changeState).toBe('updated');
    // Publishing either week publishes the move.
    const res = await publish(week(2));
    expect(res.updated).toBe(1);
    expect((await builder(main, week(4))).changes.total).toBe(0);
  });

  it('can discard unpublished edits in a range', async () => {
    await admin
      .patch(`/api/shifts/${shifts.anaMon!.id}`)
      .send(shiftOn(day(14), '07:00', '15:00'))
      .expect(200);
    await admin.delete(`/api/shifts/${shifts.anaTue!.id}`).expect(200);
    const extra = await addShift(people.ana!.id, day(19));
    expect((await builder(main, week(2))).changes.total).toBe(3);

    const res = await admin.post(`/api/schedules/${main}/discard-changes`).send(week(2));
    expect(res.status).toBe(200);
    expect(res.body.discarded).toBe(3);
    const b = await builder(main, week(2));
    expect(b.changes.total).toBe(0);
    const ids = b.shifts.map((s) => s.id);
    expect(ids).toContain(shifts.anaTue!.id);
    expect(ids).not.toContain(extra.id);
    expect(b.shifts.find((s) => s.id === shifts.anaMon!.id)!.startTime).toBe(
      shiftOn(day(14), '10:00', '18:00').startTime,
    );
    // The draft in the following week wasn't touched.
    expect((await builder(main, week(3))).changes.added).toBe(1);
  });

  it('restores a shift that was marked for removal', async () => {
    await admin.delete(`/api/shifts/${shifts.anaTue!.id}`).expect(200);
    const restored = await admin.post(`/api/shifts/${shifts.anaTue!.id}/restore`);
    expect(restored.body.changeState).toBe('unchanged');
  });

  it('copies a week into another as drafts', async () => {
    const res = await admin
      .post(`/api/schedules/${main}/copy`)
      .send({ ...week(2), targetStart: day(35) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ copied: 4, skipped: 0 });
    const copy = await builder(main, week(5));
    expect(copy.shifts.every((s) => s.changeState === 'new')).toBe(true);
    // Same wall-clock times three weeks later (even across a DST change).
    const local = (iso: string, plusDays = 0) =>
      `${addDays(localDate(iso, TZ), plusDays)} ${localTime(iso, TZ)}`;
    const originals = (await builder(main, week(2))).shifts
      .map((s) => local(s.startTime, 21))
      .sort();
    expect(copy.shifts.map((s) => local(s.startTime)).sort()).toEqual(originals);

    // Copying again skips everything that would double-book someone.
    const again = await admin
      .post(`/api/schedules/${main}/copy`)
      .send({ ...week(2), targetStart: day(35) });
    expect(again.body).toEqual({ copied: 0, skipped: 4 });
    const overlap = await admin
      .post(`/api/schedules/${main}/copy`)
      .send({ ...week(2), targetStart: day(17) });
    expect(overlap.status).toBe(400);
  });

  it('names the schedule in emails once there are several, and tells people when one is deleted', async () => {
    const extra = await admin.post('/api/schedules').send({ name: 'Weekend coverage' });
    const id = extra.body.id;
    await addShift(people.cy!.id, day(20), { scheduleId: id, start: '10:00', end: '14:00' });
    await clearEmails(ctx.db);
    await publish(undefined, id);
    const [cyMail] = await emails(ctx.db, { to: people.cy!.email });
    expect(cyMail!.text).toContain('on the Weekend coverage');

    await clearEmails(ctx.db);
    const res = await admin.delete(`/api/schedules/${id}`);
    expect(res.body).toEqual({ notified: 1 });
    const [cancel] = await emails(ctx.db, { to: people.cy!.email });
    expect(cancel!.kind).toBe('schedule_cancelled');
    expect(cancel!.subject).toMatch(/^Shift cancelled: /);
  });
});

describe('time zones', () => {
  it('returns member views in the viewer’s zone', async () => {
    // 11pm Toronto on Monday is 8pm Monday in Vancouver.
    await addShift(people.cy!.id, day(49), { start: '23:00', end: '23:30' });
    await publish(week(7));
    const van = ctx.agent();
    await ctx.db.query(`UPDATE users SET timezone = 'America/Vancouver' WHERE id = $1`, [
      people.cy!.id,
    ]);
    await login(van, people.cy!.email);
    expect(await mine(van, day(49), day(49))).toHaveLength(1);
    await ctx.db.query(`UPDATE users SET timezone = 'Europe/London' WHERE id = $1`, [
      people.cy!.id,
    ]);
    expect(await mine(van, day(49), day(49))).toHaveLength(0); // already Tuesday in London
    expect(TZ).toBe('America/Toronto');
  });
});
