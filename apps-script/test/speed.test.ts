// Keeping the app quick on Google: reads come from a cache instead of the
// Sheet, batches share one read of each tab, and the email log (the biggest
// tab) is only read when something is waiting in it.
import { addDays } from '@shared/time';
import { beforeAll, describe, expect, it } from 'vitest';
import * as main from '../src/main';
import { activate } from './emulator';
import {
  clearEmails,
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
let boss: { id: string; email: string };
let ana: { id: string; email: string };
const reads = () => ctx.env.book.reads;
const get = (url: string) => admin.get(`/api${url}`).expect(200);
const names = (body: { name: string }[]) => body.map((t) => t.name);

beforeAll(async () => {
  ctx = await createTestContext();
  schedule = await defaultScheduleId(ctx.db);
  const tier = await createTier(ctx.db, 'Tier 1');
  boss = await createUser(ctx.db, { name: 'Boss Admin', role: 'admin' });
  ana = await createUser(ctx.db, { name: 'Ana Ortiz', tierId: tier });
  admin = ctx.agent();
  await login(admin, boss.email);
});

describe('reads from the cache', () => {
  it('reads a tab from the Sheet once, then from the cache', async () => {
    ctx.env.cache.clear();
    await get('/tiers');
    const cold = reads();
    await get('/tiers');
    await get('/tiers');
    expect(reads()).toBe(cold);
  });

  it('shows a change right after it is made', async () => {
    await get('/tiers');
    await admin.post('/api/tiers').send({ name: 'Night crew', color: '#4f46e5' }).expect(201);
    expect(names((await get('/tiers')).body)).toContain('Night crew');
    const again = reads();
    await get('/tiers');
    expect(reads()).toBe(again); // and that's cached again
  });

  it('sees a change made by another run of the script', async () => {
    await get('/tiers');
    // Another person using the app adds a tier: it changes the Sheet and its generation.
    ctx.db.write((t) => t.tiers.insert({ name: 'Weekend crew', color: '#0891b2', sortOrder: 9 }));
    expect(names((await get('/tiers')).body)).toContain('Weekend crew');
  });

  it('keeps working when the cache does not', async () => {
    ctx.env.cacheDown = true;
    try {
      expect(names((await get('/tiers')).body)).toContain('Tier 1');
      await admin.post('/api/tiers').send({ name: 'Cache-less', color: '#4f46e5' }).expect(201);
    } finally {
      ctx.env.cacheDown = false;
    }
    expect(names((await get('/tiers')).body)).toContain('Cache-less');
  });

  it('caches tabs bigger than one cache entry, and gives back the same rows', async () => {
    ctx.db.write((t) => {
      for (let n = 0; n < 400; n++) {
        const times = shiftOn(addDays(nextMonday(), 30 + (n % 60)), '09:00', '17:00');
        t.shifts.insert({
          scheduleId: schedule,
          userId: ana.id,
          labelId: null,
          ...times,
          notes: `Shift number ${n} with a longish note so the tab is big enough to need pieces`,
          status: 'pending',
          confirmedAt: null,
          publishedAt: null,
          publishedUserId: null,
          publishedLabelId: null,
          publishedStartTime: null,
          publishedEndTime: null,
          publishedNotes: null,
          deletedAt: null,
          reminderSentAt: null,
          createdBy: null,
        });
      }
    });
    const from = addDays(nextMonday(), 30);
    const url = `/schedules/${schedule}?from=${from}&to=${addDays(from, 59)}`;
    ctx.env.cache.clear();
    const first = await get(url);
    const after = reads();
    const second = await get(url);
    expect(reads()).toBe(after);
    expect(second.body).toEqual(first.body);
    expect(first.body.shifts.length).toBe(400);
    const pieces = [...ctx.env.cache.keys()].filter((k) => k.startsWith('toretto:shifts:'));
    expect(pieces.length).toBeGreaterThan(1);
  });

  it('never caches the email log', async () => {
    await get('/admin/notifications');
    await get('/admin/notifications');
    expect([...ctx.env.cache.keys()].some((k) => k.includes('email_log'))).toBe(false);
  });
});

describe('batches', () => {
  const calls = (...urls: string[]) => JSON.stringify(urls.map((u) => ['GET', u]));

  it('read each tab once, even with /bootstrap in the batch', () => {
    ctx.env.cache.clear();
    activate(ctx.env);
    ctx.env.activeUser = boss.email;
    const before = reads();
    const results = JSON.parse(
      main.apiBatch(
        calls(
          '/bootstrap',
          '/tiers',
          '/teams',
          '/schedules',
          `/schedules/${schedule}?from=${nextMonday()}&to=${addDays(nextMonday(), 6)}`,
          '/admin/settings',
          '/open-shifts',
        ),
      ),
    );
    expect(results.map((r: { status: number }) => r.status)).toEqual([
      200, 200, 200, 200, 200, 200, 200,
    ]);
    // At most one read per tab (there are 14), against dozens when each call read for itself.
    expect(reads() - before).toBeLessThanOrEqual(14);
    const again = reads();
    main.apiBatch(calls('/tiers', '/teams', '/schedules'));
    expect(reads()).toBe(again);
  });
});

describe('the email log', () => {
  const emailReads = () => ctx.env.book.sheets.get('email_log')!.reads;

  it('is only read when an email is waiting', async () => {
    await clearEmails(ctx.db);
    ctx.env.properties.delete('EMAILS_WAITING');
    activate(ctx.env);
    const before = emailReads();
    expect(main.sendQueuedEmails()).toBe(0);
    expect(main.sendQueuedEmails()).toBe(0);
    expect(emailReads()).toBe(before);
  });

  it('is read, and sent from, once something is queued, then left alone again', async () => {
    await admin
      .post(`/api/schedules/${schedule}/shifts`)
      .send({ userId: ana.id, ...shiftOn(nextMonday(), '09:00', '17:00') })
      .expect(201);
    await admin.post(`/api/schedules/${schedule}/publish`).send({}).expect(200);
    expect(ctx.env.properties.get('EMAILS_WAITING')).toBe('1');
    activate(ctx.env);
    expect(main.sendQueuedEmails()).toBeGreaterThan(0);
    expect(ctx.env.properties.get('EMAILS_WAITING')).toBeUndefined();
    const before = emailReads();
    expect(main.sendQueuedEmails()).toBe(0);
    expect(emailReads()).toBe(before);
  });

  it('stays flagged while a failed email waits to be retried', async () => {
    ctx.env.failFor.add(ana.email);
    await admin
      .post(`/api/schedules/${schedule}/shifts`)
      .send({ userId: ana.id, ...shiftOn(addDays(nextMonday(), 1), '09:00', '17:00') })
      .expect(201);
    await admin.post(`/api/schedules/${schedule}/publish`).send({}).expect(200);
    activate(ctx.env);
    expect(main.sendQueuedEmails()).toBe(0);
    expect(ctx.env.properties.get('EMAILS_WAITING')).toBe('1');
    ctx.env.failFor.clear();
  });
});

describe('diagnose', () => {
  it('times each step the Scheduler page takes, from the editor', () => {
    activate(ctx.env);
    ctx.env.activeUser = boss.email;
    const report = main.diagnose();
    expect(report).toMatch(/lock \(get and release\)/);
    expect(report).toMatch(/read tab shifts {2}\d+ rows/);
    expect(report).toMatch(/\[again\] the schedule for two weeks {2}status 200/);
    expect(report).toMatch(/TOTAL/);
    expect(report).not.toMatch(/FAILED|COULD NOT/);
  });
});
