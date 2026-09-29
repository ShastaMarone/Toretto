// Google Calendar: confirmed shifts and approved time off, as invitations
// from the app's calendar, kept up to date in the background.
import { addDays } from '@shared/time';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BATCH, KEEP_DAYS, LEASE, syncCalendars } from '../src/services/calendar';
import { runHourlyJobs } from '../src/services/jobs';
import * as main from '../src/main';
import { activate, calendarEvents, type FakeEvent } from './emulator';
import {
  APP_URL,
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

let ctx: TestContext;
let schedule: string;
let admin: Agent;
let ana: Agent;
let bo: Agent;
const people: Record<'admin' | 'ana' | 'bo', { id: string; email: string }> = {} as never;
const day = (n: number) => addDays(nextMonday(), n);

/** What the background job does after a change (and every 5 minutes). */
const sync = () => {
  activate(ctx.env);
  return syncCalendars();
};
const eventsOf = (who: { email: string }): FakeEvent[] =>
  calendarEvents(ctx.env)
    .filter((e) => e.guests.includes(who.email))
    .sort((a, b) => a.start.localeCompare(b.start));

async function publishedShift(userId: string, n: number, start = '09:00', end = '17:00') {
  const shift = (
    await admin
      .post(`/api/schedules/${schedule}/shifts`)
      .send({ userId, ...shiftOn(day(n), start, end) })
      .expect(201)
  ).body as { id: string; startTime: string; endTime: string };
  await admin.post(`/api/schedules/${schedule}/publish`).send({}).expect(200);
  return shift;
}

const confirm = (who: Agent, id: string) => who.post(`/api/my/shifts/${id}/confirm`).expect(200);
const turn = (who: Agent, calendarSync: boolean) =>
  who.patch('/api/me').send({ calendarSync }).expect(200);

beforeAll(async () => {
  ctx = await createTestContext();
  schedule = await defaultScheduleId(ctx.db);
  const tier = await createTier(ctx.db, 'Tier 1');
  people.admin = await createUser(ctx.db, { name: 'Robin Admin', role: 'admin' });
  people.ana = await createUser(ctx.db, { name: 'Ana Ortiz', tierId: tier });
  people.bo = await createUser(ctx.db, { name: 'Bo Lee', tierId: tier });
  [admin, ana, bo] = [ctx.agent(), ctx.agent(), ctx.agent()];
  await login(admin, people.admin.email);
  await login(ana, people.ana.email);
  await login(bo, people.bo.email);
});

beforeEach(() => {
  // Each test starts with nothing on calendars and nobody using them.
  ctx.db.write((t) => {
    for (const s of t.shifts.all()) t.shifts.delete(s.id);
    for (const r of t.timeOff.all()) t.timeOff.delete(r.id);
    for (const r of t.calendarEvents.all()) t.calendarEvents.delete(r.id);
    for (const u of t.users.all()) t.users.update(u.id, { calendarSync: false });
  });
  ctx.env.calendars.clear();
  ctx.env.properties.delete('CALENDAR_ID');
  ctx.env.properties.delete(LEASE);
  ctx.env.calendarFailFor.clear();
  ctx.env.calendarDown = null;
});

describe('Google Calendar', () => {
  it("is off until someone turns it on, and says it's there to turn on", async () => {
    const shift = await publishedShift(people.ana.id, 1);
    await confirm(ana, shift.id);
    expect(sync()).toBe(0);
    expect(ctx.env.calendars.size).toBe(0);
    const boot = await ana.get('/api/bootstrap').expect(200);
    expect(boot.body).toMatchObject({ calendarSync: true, user: { calendarSync: false } });
  });

  it('adds confirmed upcoming shifts when turned on, as invitations from the app calendar', async () => {
    const confirmed = await publishedShift(people.ana.id, 1);
    const unconfirmed = await publishedShift(people.ana.id, 2);
    await confirm(ana, confirmed.id);
    expect(unconfirmed.id).toBeTruthy();

    const kicks = ctx.kicks();
    const res = await turn(ana, true);
    expect(res.body.user.calendarSync).toBe(true);
    expect(ctx.kicks()).toBe(kicks + 1); // the page asks for it to happen now
    expect(sync()).toBe(1);

    const [calendar] = [...ctx.env.calendars.values()];
    expect(calendar!.name).toBe('My Team shifts');
    expect(eventsOf(people.ana)).toEqual([
      expect.objectContaining({
        title: 'Shift',
        start: confirmed.startTime,
        end: confirmed.endTime,
        guests: [people.ana.email],
        sendInvites: false,
        allDay: false,
        description: `Open the schedule: ${APP_URL}/my-schedule`,
      }),
    ]);
    // Nothing left to do.
    const calls = ctx.env.calendarCalls;
    expect(sync()).toBe(0);
    expect(ctx.env.calendarCalls).toBe(calls);
  });

  it('adds a shift once it is confirmed', async () => {
    await turn(ana, true);
    const shift = await publishedShift(people.ana.id, 3);
    sync();
    expect(eventsOf(people.ana)).toEqual([]);
    const kicks = ctx.kicks();
    await confirm(ana, shift.id);
    expect(ctx.kicks()).toBeGreaterThan(kicks);
    sync();
    expect(eventsOf(people.ana).map((e) => e.start)).toEqual([shift.startTime]);
  });

  it('follows changes once published, and asks for the new time to be confirmed', async () => {
    await turn(ana, true);
    const shift = await publishedShift(people.ana.id, 1);
    await confirm(ana, shift.id);
    sync();

    const later = shiftOn(day(1), '12:00', '20:00');
    await admin.patch(`/api/shifts/${shift.id}`).send(later).expect(200);
    sync();
    // A draft change isn't on the calendar...
    expect(eventsOf(people.ana)[0]).toMatchObject({ start: shift.startTime });
    await admin.post(`/api/schedules/${schedule}/publish`).send({}).expect(200);
    sync();
    // ...until it's published.
    const [event] = eventsOf(people.ana);
    expect(event).toMatchObject({ start: later.startTime, end: later.endTime });
    expect(event!.description).toContain('This shift changed. Please confirm it in the app.');

    await confirm(ana, shift.id);
    sync();
    expect(eventsOf(people.ana)[0]!.description).not.toContain('Please confirm');
    expect(eventsOf(people.ana)).toHaveLength(1);
  });

  it('names the label and shows notes', async () => {
    await turn(ana, true);
    const label = (
      await admin
        .post('/api/labels')
        .send({ name: 'On-Call', color: '#dc2626', tierId: null })
        .expect(201)
    ).body as { id: string };
    const shift = (
      await admin
        .post(`/api/schedules/${schedule}/shifts`)
        .send({
          userId: people.ana.id,
          labelId: label.id,
          notes: 'Bring the pager',
          ...shiftOn(day(4)),
        })
        .expect(201)
    ).body as { id: string };
    await admin.post(`/api/schedules/${schedule}/publish`).send({}).expect(200);
    await confirm(ana, shift.id);
    sync();
    expect(eventsOf(people.ana)[0]).toMatchObject({ title: 'On-Call shift' });
    expect(eventsOf(people.ana)[0]!.description).toContain('Notes: Bring the pager');
    await admin.delete(`/api/labels/${label.id}`).expect(204);
  });

  it('takes cancelled shifts off', async () => {
    await turn(ana, true);
    const shift = await publishedShift(people.ana.id, 2);
    await confirm(ana, shift.id);
    sync();
    expect(eventsOf(people.ana)).toHaveLength(1);
    await admin.delete(`/api/shifts/${shift.id}`).expect(200); // removed when published
    sync();
    expect(eventsOf(people.ana)).toHaveLength(1);
    await admin.post(`/api/schedules/${schedule}/publish`).send({}).expect(200);
    sync();
    expect(eventsOf(people.ana)).toEqual([]);
    expect(ctx.db.read((t) => t.calendarEvents.all())).toEqual([]);
  });

  it("moves a reassigned shift to the new person's calendar once they confirm it", async () => {
    await turn(ana, true);
    await turn(bo, true);
    const shift = await publishedShift(people.ana.id, 1);
    await confirm(ana, shift.id);
    sync();
    await admin.patch(`/api/shifts/${shift.id}`).send({ userId: people.bo.id }).expect(200);
    await admin.post(`/api/schedules/${schedule}/publish`).send({}).expect(200);
    sync();
    expect(eventsOf(people.ana)).toEqual([]);
    expect(eventsOf(people.bo)).toEqual([]);
    await confirm(bo, shift.id);
    sync();
    expect(eventsOf(people.bo).map((e) => e.start)).toEqual([shift.startTime]);
  });

  it('adds approved time off, all day or for its hours, and takes it off when cancelled', async () => {
    await turn(ana, true);
    const types = (await ana.get('/api/time-off-types').expect(200)).body as {
      id: string;
      name: string;
    }[];
    const vacation = types.find((t) => t.name === 'Vacation')!;
    const personal = types.find((t) => t.name === 'Personal Day')!;
    const week = (
      await ana
        .post('/api/my/time-off')
        .send({ typeId: vacation.id, startDate: day(7), endDate: day(8), note: 'Cottage' })
        .expect(201)
    ).body as { id: string };
    const hours = shiftOn(day(9), '13:00', '15:00');
    const dentist = (
      await ana
        .post('/api/my/time-off')
        .send({ typeId: personal.id, ...hours })
        .expect(201)
    ).body as { id: string };
    sync();
    expect(eventsOf(people.ana)).toEqual([]); // not approved yet
    await admin.post(`/api/time-off/${week.id}/approve`).send({}).expect(200);
    await admin.post(`/api/time-off/${dentist.id}/approve`).send({}).expect(200);
    sync();
    expect(eventsOf(people.ana)).toEqual([
      expect.objectContaining({
        title: 'Time off: Vacation',
        allDay: true,
        start: day(7),
        end: day(9), // the day after, as Google Calendar counts all-day events
        description: `Note: Cottage\nOpen the schedule: ${APP_URL}/my-schedule`,
      }),
      expect.objectContaining({
        title: 'Time off: Personal Day',
        allDay: false,
        start: hours.startTime,
        end: hours.endTime,
      }),
    ]);
    await ana.post(`/api/my/time-off/${week.id}/cancel`).expect(200);
    sync();
    expect(eventsOf(people.ana).map((e) => e.title)).toEqual(['Time off: Personal Day']);
  });

  it('takes upcoming events off when turned off, and leaves past ones', async () => {
    await turn(ana, true);
    const [past, upcoming] = [
      await publishedShift(people.ana.id, 1),
      await publishedShift(people.ana.id, 2),
    ];
    await confirm(ana, past.id);
    await confirm(ana, upcoming.id);
    sync();
    expect(eventsOf(people.ana)).toHaveLength(2);
    // Let the first one be over.
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    ctx.db.write((t) => {
      t.shifts.update(past.id, { publishedStartTime: ago(10), publishedEndTime: ago(2) });
      const row = t.calendarEvents.find((r) => r.key === `shift:${past.id}`)!;
      t.calendarEvents.update(row.id, { endsAt: ago(2) });
    });
    await turn(ana, false);
    sync();
    expect(eventsOf(people.ana).map((e) => e.start)).toEqual([past.startTime]);
  });

  it('tries again later when Google Calendar says no', async () => {
    await turn(bo, true);
    ctx.env.calendarFailFor.add(people.bo.email);
    const shift = await publishedShift(people.bo.id, 5);
    await confirm(bo, shift.id);
    expect(sync()).toBe(0);
    const [row] = ctx.db.read((t) => t.calendarEvents.all());
    expect(row).toMatchObject({
      eventId: null,
      attempts: 1,
      lastError: `Invalid guest: ${people.bo.email}`,
    });
    expect(Date.parse(row!.retryAfter!)).toBeGreaterThan(Date.now());

    // Not yet: it waits a minute first.
    const calls = ctx.env.calendarCalls;
    expect(sync()).toBe(0);
    expect(ctx.env.calendarCalls).toBe(calls);

    ctx.env.calendarFailFor.clear();
    ctx.db.write((t) =>
      t.calendarEvents.update(row!.id, { retryAfter: new Date(Date.now() - 1000).toISOString() }),
    );
    expect(sync()).toBe(1);
    expect(eventsOf(people.bo)).toHaveLength(1);
    expect(ctx.db.read((t) => t.calendarEvents.all())[0]).toMatchObject({
      attempts: 0,
      lastError: null,
    });
  });

  it("makes a new calendar if the app's was deleted, and adds everything again", async () => {
    await turn(ana, true);
    const shift = await publishedShift(people.ana.id, 1);
    await confirm(ana, shift.id);
    sync();
    ctx.env.calendars.clear();
    activate(ctx.env);
    runHourlyJobs(); // notices, and adds them to a new one
    expect(ctx.env.calendars.size).toBe(1);
    expect(eventsOf(people.ana).map((e) => e.start)).toEqual([shift.startTime]);
  });

  it('pauses when it has no access to Google Calendar, instead of trying after every change', async () => {
    await turn(ana, true);
    const shift = await publishedShift(people.ana.id, 1);
    await confirm(ana, shift.id);
    ctx.env.calendarDown = 'You do not have permission to call CalendarApp.createCalendar';
    expect(sync()).toBe(0);
    expect(Number(ctx.env.properties.get(LEASE))).toBeGreaterThan(Date.now());
    ctx.env.calendarDown = null;
    expect(sync()).toBe(0); // still paused
    ctx.env.properties.delete(LEASE);
    expect(sync()).toBe(1);
  });

  it("doesn't run twice at once", async () => {
    await turn(ana, true);
    const shift = await publishedShift(people.ana.id, 1);
    await confirm(ana, shift.id);
    ctx.env.properties.set(LEASE, String(Date.now() + 60_000));
    expect(sync()).toBe(0);
    expect(ctx.env.calendars.size).toBe(0);
  });

  it(`makes at most ${BATCH} changes per run`, async () => {
    await turn(ana, true);
    ctx.db.write((t) => {
      for (let n = 0; n < BATCH + 5; n++) {
        const times = shiftOn(day(n), '09:00', '10:00');
        t.shifts.insert({
          scheduleId: schedule,
          userId: people.ana.id,
          labelId: null,
          ...times,
          notes: null,
          status: 'confirmed',
          confirmedAt: new Date().toISOString(),
          publishedAt: new Date().toISOString(),
          publishedUserId: people.ana.id,
          publishedLabelId: null,
          publishedStartTime: times.startTime,
          publishedEndTime: times.endTime,
          publishedNotes: null,
          deletedAt: null,
          reminderSentAt: null,
          createdBy: people.admin.id,
        });
      }
    });
    expect(sync()).toBe(BATCH);
    expect(sync()).toBe(5);
    expect(eventsOf(people.ana)).toHaveLength(BATCH + 5);
  });

  it('runs with the emails, and the hourly job forgets rows for events long over', async () => {
    await turn(ana, true);
    const shift = await publishedShift(people.ana.id, 1);
    await confirm(ana, shift.id);
    activate(ctx.env);
    main.sendQueuedEmails();
    expect(eventsOf(people.ana)).toHaveLength(1);

    // The shift was more than a month ago.
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    ctx.db.write((t) => {
      const [start, end] = [ago(KEEP_DAYS + 1.5), ago(KEEP_DAYS + 1)];
      t.shifts.update(shift.id, { publishedStartTime: start, publishedEndTime: end });
      const row = t.calendarEvents.all()[0]!;
      t.calendarEvents.update(row.id, { endsAt: end });
    });
    activate(ctx.env);
    runHourlyJobs();
    expect(ctx.db.read((t) => t.calendarEvents.all())).toEqual([]);
    expect(eventsOf(people.ana)).toHaveLength(1); // still on their calendar
  });

  it('asks the page to update calendars after changes, only when someone uses them', async () => {
    const shift = await publishedShift(people.ana.id, 1);
    let kicks = ctx.kicks();
    await admin
      .patch(`/api/shifts/${shift.id}`)
      .send(shiftOn(day(1), '10:00', '18:00'))
      .expect(200);
    expect(ctx.kicks()).toBe(kicks);
    await turn(bo, true);
    kicks = ctx.kicks();
    await admin
      .patch(`/api/shifts/${shift.id}`)
      .send(shiftOn(day(1), '11:00', '19:00'))
      .expect(200);
    expect(ctx.kicks()).toBe(kicks + 1);
    await admin.get('/api/schedules').expect(200);
    expect(ctx.kicks()).toBe(kicks + 1);
  });
});
