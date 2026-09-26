import { addDays } from '@shared/time';
import type { CalendarFeed, TimeOffType } from '@shared/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_URL,
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

// Each person can subscribe to their own shifts from Google Calendar (or any
// calendar app) with a secret link.

let ctx: TestContext;
let admin: Agent;
let priya: Agent;
let main: string;
let people: Record<'priya' | 'sam', { id: string; email: string }>;
const shifts: Record<string, string> = {};
const monday = nextMonday();
const day = (n: number) => addDays(monday, n);
/** 2026-10-12T13:00:00.000Z → 20261012T130000Z */
const utc = (iso: string) => iso.replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.db.query("UPDATE org_settings SET org_name = 'Night Crew'");
  main = await defaultScheduleId(ctx.db);
  const tier = await createTier(ctx.db, 'Tier 1');
  const chat = await createLabel(ctx.db, 'Chat Queue', tier);
  const boss = await createUser(ctx.db, { name: 'Robin Admin', role: 'admin' });
  people = {
    priya: await createUser(ctx.db, { name: 'Priya Patel', tierId: tier }),
    sam: await createUser(ctx.db, { name: 'Sam Chen', tierId: tier }),
  };
  admin = ctx.agent();
  priya = ctx.agent();
  await login(admin, boss.email);
  await login(priya, people.priya.email);

  const add = async (userId: string, n: number, extra: Record<string, unknown> = {}) =>
    (
      await admin
        .post(`/api/schedules/${main}/shifts`)
        .send({ userId, ...shiftOn(day(n)), ...extra })
        .expect(201)
    ).body.id as string;
  shifts.monday = await add(people.priya.id, 0, {
    labelId: chat,
    notes: 'Bring a headset; room 4, floor 2',
  });
  shifts.sams = await add(people.sam.id, 1);
  await admin.post(`/api/schedules/${main}/publish`).send({}).expect(200);
  // Added after publishing, so still a draft.
  shifts.draft = await add(people.priya.id, 2);

  const types = (await priya.get('/api/time-off-types')).body as TimeOffType[];
  const typeId = (name: string) => types.find((t) => t.name === name)!.id;
  const vacation = await priya
    .post('/api/my/time-off')
    .send({ typeId: typeId('Vacation'), startDate: day(3), endDate: day(4), note: 'Cottage' })
    .expect(201);
  await admin.post(`/api/time-off/${vacation.body.id}/approve`).send({}).expect(200);
  await priya
    .post('/api/my/time-off')
    .send({ typeId: typeId('Personal Day'), startDate: day(9), endDate: day(9) })
    .expect(201);
});
afterAll(async () => {
  await ctx.close();
});

/** Fetch a feed the way a calendar app would: no cookies. */
async function fetchFeed(url: string) {
  return request(ctx.app).get(new URL(url).pathname);
}

/** Each event's properties, e.g. { UID: '…', 'DTSTART;VALUE=DATE': '20261012' }. */
function events(ics: string): Record<string, string>[] {
  return ics
    .replace(/\r\n /g, '')
    .split('BEGIN:VEVENT\r\n')
    .slice(1)
    .map((block) =>
      Object.fromEntries(
        block
          .slice(0, block.indexOf('END:VEVENT'))
          .split('\r\n')
          .filter(Boolean)
          .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)]),
      ),
    );
}

describe('calendar feed', () => {
  let url: string;

  it('is off until you turn it on, and needs you signed in to manage', async () => {
    expect((await priya.get('/api/me/calendar')).body).toEqual({ url: null });
    expect((await request(ctx.app).get('/api/me/calendar')).status).toBe(401);
    expect((await request(ctx.app).post('/api/me/calendar')).status).toBe(401);
  });

  it('gives you a secret link you can see again later', async () => {
    const res = await priya.post('/api/me/calendar');
    expect(res.status).toBe(200);
    url = (res.body as CalendarFeed).url!;
    expect(url).toMatch(new RegExp(`^${APP_URL}/api/calendar/[A-Za-z0-9_-]{43}\\.ics$`));
    expect((await priya.get('/api/me/calendar')).body).toEqual({ url });
  });

  it('has your published shifts and approved time off, without signing in', async () => {
    const res = await fetchFeed(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(res.text).toContain('\r\nX-WR-CALNAME:Night Crew shifts\r\n');

    const list = events(res.text);
    const { startTime, endTime } = shiftOn(day(0));
    expect(list.find((e) => e.UID === `${shifts.monday}@toretto`)).toMatchObject({
      DTSTART: utc(startTime),
      DTEND: utc(endTime),
      SUMMARY: 'Chat Queue shift',
      DESCRIPTION: `Notes: Bring a headset\\; room 4\\, floor 2\\nView in Toretto: ${APP_URL}/my-schedule`,
    });
    expect(list.find((e) => e.SUMMARY === 'Time off: Vacation')).toMatchObject({
      'DTSTART;VALUE=DATE': day(3).replaceAll('-', ''),
      // The day after the last day off.
      'DTEND;VALUE=DATE': day(5).replaceAll('-', ''),
      DESCRIPTION: `Note: Cottage\\nView in Toretto: ${APP_URL}/my-schedule`,
      TRANSP: 'TRANSPARENT',
    });
    // Not drafts, not someone else's shifts, not requests still waiting for an answer.
    expect(list).toHaveLength(2);
    expect(res.text).not.toContain(shifts.draft);
    expect(res.text).not.toContain(shifts.sams);
    expect(res.text).not.toContain('Personal Day');
  });

  it('shows changes once they are published', async () => {
    const later = shiftOn(day(0), '10:00', '18:00');
    await admin.patch(`/api/shifts/${shifts.monday}`).send(later).expect(200);
    expect((await fetchFeed(url)).text).not.toContain(`DTSTART:${utc(later.startTime)}`);
    await admin.post(`/api/schedules/${main}/publish`).send({}).expect(200);
    const ics = (await fetchFeed(url)).text;
    expect(ics).toContain(`DTSTART:${utc(later.startTime)}`);
    // The shift that was a draft is published now too.
    expect(ics).toContain(`UID:${shifts.draft}@toretto`);
  });

  it('names the schedule when there is more than one', async () => {
    const projects = (await admin.post('/api/schedules').send({ name: 'Projects' })).body.id;
    await admin
      .post(`/api/schedules/${projects}/shifts`)
      .send({ userId: people.priya.id, ...shiftOn(day(7)) })
      .expect(201);
    await admin.post(`/api/schedules/${projects}/publish`).send({}).expect(200);
    const descriptions = events((await fetchFeed(url)).text).map((e) => e.DESCRIPTION);
    expect(descriptions).toContain(`Schedule: Projects\\nView in Toretto: ${APP_URL}/my-schedule`);
    expect(descriptions.filter((d) => d?.startsWith('Schedule: Main schedule\\n'))).toHaveLength(2);
  });

  it('swaps in a new link on request, and the old one stops working', async () => {
    const res = await priya.post('/api/me/calendar');
    const next = (res.body as CalendarFeed).url!;
    expect(next).not.toBe(url);
    expect((await fetchFeed(url)).status).toBe(404);
    expect((await fetchFeed(next)).status).toBe(200);
    url = next;
  });

  it('stops working for someone who is deactivated', async () => {
    await ctx.db.query('UPDATE users SET deactivated_at = now() WHERE id = $1', [people.priya.id]);
    expect((await fetchFeed(url)).status).toBe(404);
    await ctx.db.query('UPDATE users SET deactivated_at = NULL WHERE id = $1', [people.priya.id]);
    expect((await fetchFeed(url)).status).toBe(200);
  });

  it('can be turned off', async () => {
    expect((await priya.delete('/api/me/calendar')).status).toBe(204);
    expect((await fetchFeed(url)).status).toBe(404);
    expect((await priya.get('/api/me/calendar')).body).toEqual({ url: null });
  });

  it('turns away links that are not feed links', async () => {
    const token = new URL(url).pathname.split('/').pop()!.replace('.ics', '');
    for (const path of ['/api/calendar/nope.ics', `/api/calendar/${token}`, '/api/calendar/']) {
      expect((await request(ctx.app).get(path)).status).toBe(404);
    }
  });
});
