// Keeping the app quick on Google: reads come from a cache instead of the
// Sheet, batches share one read of each tab, and the email log (the biggest
// tab) is only read when something is waiting in it.
import { addDays } from '@shared/time';
import { beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/db/store';
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

  it('a save only clears the tabs it wrote', async () => {
    await get('/tiers');
    await get('/teams');
    await admin.post('/api/tiers').send({ name: 'Only tiers', color: '#4f46e5' }).expect(201);
    const teams = ctx.env.book.sheets.get('teams')!.reads;
    await get('/teams');
    expect(ctx.env.book.sheets.get('teams')!.reads).toBe(teams);
  });

  it('a save reads from the cache too, not the Sheet', async () => {
    await get('/tiers');
    const tiers = ctx.env.book.sheets.get('tiers')!;
    const before = tiers.reads;
    await admin.post('/api/tiers').send({ name: 'No re-read', color: '#4f46e5' }).expect(201);
    expect(tiers.reads).toBe(before);
    expect(names((await get('/tiers')).body)).toContain('No re-read');
  });

  it('does not overwrite a row someone added to the Sheet by hand', async () => {
    await get('/tiers'); // cached
    const sheet = ctx.env.book.sheets.get('tiers')!;
    const column = (name: string) => {
      for (let c = 1; c <= sheet.getLastColumn(); c++) if (sheet.cell(1, c) === name) return c;
      throw new Error(`no ${name} column`);
    };
    const row = sheet.getLastRow() + 1;
    sheet.set(row, column('id'), 'added-by-hand');
    sheet.set(row, column('name'), 'Added by hand');
    sheet.set(row, column('color'), '#111111');
    sheet.set(row, column('sort_order'), '98');
    await admin.post('/api/tiers').send({ name: 'Added by app', color: '#4f46e5' }).expect(201);
    const found = names((await get('/tiers')).body);
    expect(found).toContain('Added by hand');
    expect(found).toContain('Added by app');
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

describe('a save fills the cache', () => {
  const sheetReads = (tab: string) => ctx.env.book.sheets.get(tab)!.reads;
  /** The tab as the cache has it, and as the Sheet has it. */
  const both = (tab: string) => {
    activate(ctx.env);
    const reader = Db.reader();
    const cached = JSON.stringify(reader.readValues(tab));
    expect(reader.servedFromCache(tab)).toBe(true);
    return { cached, sheet: JSON.stringify(new Db().readValues(tab)) };
  };

  it('the refresh right after a save reads nothing from the Sheet', async () => {
    await get('/tiers');
    await admin
      .post('/api/tiers')
      .send({ name: 'Straight to cache', color: '#4f46e5' })
      .expect(201);
    const before = sheetReads('tiers');
    expect(names((await get('/tiers')).body)).toContain('Straight to cache');
    expect(sheetReads('tiers')).toBe(before);
  });

  it('caches exactly what the Sheet holds when rows are added and deleted in one save', () => {
    ctx.db.write((t) => {
      const gone = t.tiers.insert({ name: 'Added then deleted', color: '#111111' });
      t.tiers.insert({ name: 'Added and kept', color: '#222222' });
      t.tiers.delete(gone.id);
    });
    const { cached, sheet } = both('tiers');
    expect(cached).toBe(sheet);
    expect(cached).toContain('Added and kept');
  });

  it('leaves no blank row at the end when the last row is deleted', () => {
    const id = ctx.db.write((t) => t.tiers.insert({ name: 'Last one', color: '#333333' }).id);
    ctx.db.write((t) => t.tiers.delete(id));
    const { cached, sheet } = both('tiers');
    expect(cached).toBe(sheet);
  });

  it('a save after that still notices rows added by hand', async () => {
    await get('/tiers');
    const sheet = ctx.env.book.sheets.get('tiers')!;
    const column = (name: string) => {
      for (let c = 1; c <= sheet.getLastColumn(); c++) if (sheet.cell(1, c) === name) return c;
      throw new Error(`no ${name} column`);
    };
    const row = sheet.getLastRow() + 1;
    sheet.set(row, column('id'), 'by-hand-after-write-through');
    sheet.set(row, column('name'), 'By hand again');
    sheet.set(row, column('color'), '#111111');
    await admin.post('/api/tiers').send({ name: 'After hand edit', color: '#4f46e5' }).expect(201);
    const found = names((await get('/tiers')).body);
    expect(found).toContain('By hand again');
    expect(found).toContain('After hand edit');
  });
});

describe('the hourly job', () => {
  it('leaves the cache filled, so the next screen reads nothing from the Sheet', async () => {
    main.runHourlyJobs();
    const before = reads();
    await get('/tiers');
    await get('/teams');
    await get('/schedules');
    expect(reads()).toBe(before);
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
