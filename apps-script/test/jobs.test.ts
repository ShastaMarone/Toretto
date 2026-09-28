// What only the Apps Script version has: setup(), Gmail sending, the timed
// jobs, the page itself, and the built Code.gs running in a bare sandbox.
import vm from 'node:vm';
import { addDays } from '@shared/time';
import type { ShiftSwap } from '@shared/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../build.mjs';
import * as main from '../src/main';
import { activate, createEmulator, installAppsScript } from './emulator';
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
let main_: string;
let admin: Agent;
let ana: Agent;
const people: Record<'admin' | 'ana' | 'bo', { id: string; email: string }> = {} as never;
const day = (n: number) => addDays(nextMonday(), n);
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

beforeAll(async () => {
  ctx = await createTestContext();
  main_ = await defaultScheduleId(ctx.db);
  const tier = await createTier(ctx.db, 'Tier 1');
  people.admin = await createUser(ctx.db, { name: 'Robin Admin', role: 'admin' });
  people.ana = await createUser(ctx.db, { name: 'Ana Ortiz', tierId: tier });
  people.bo = await createUser(ctx.db, { name: 'Bo Lee', tierId: tier });
  [admin, ana] = [ctx.agent(), ctx.agent()];
  await login(admin, people.admin.email);
  await login(ana, people.ana.email);
});
afterAll(() => ctx.close());
beforeEach(() => {
  ctx.env.sent.length = 0;
  ctx.env.failFor.clear();
  ctx.env.quota = 1500;
  return clearEmails(ctx.db);
});

const sendNow = () => {
  activate(ctx.env);
  return main.sendQueuedEmails();
};
const email = (to: string) => ctx.db.read((t) => t.notifications.find((n) => n.toEmail === to)!);

describe('setup()', () => {
  it('creates the tabs and starts the timed jobs, and is safe to run again', async () => {
    const fresh = createEmulator();
    activate(fresh);
    const summary = main.setup();
    expect(summary).toContain('Made owner@example.com an admin');
    expect([...fresh.book.sheets.keys()]).toEqual(
      expect.arrayContaining(['users', 'shifts', 'shift_swaps', 'open_shifts', 'email_log']),
    );
    expect(fresh.book.getSheetByName('users')!.records()[0]).toMatchObject({
      email: 'owner@example.com',
      role: 'admin',
    });
    main.setup();
    expect(fresh.triggers).toEqual([
      { handler: 'sendQueuedEmails', every: '5 minutes' },
      { handler: 'runHourlyJobs', every: '1 hours' },
    ]);
    expect(fresh.book.getSheetByName('users')!.records()).toHaveLength(1);
    expect(fresh.book.getSheetByName('time_off_types')!.records()).toHaveLength(5);
    expect(fresh.book.getSheetByName('schedules')!.records()).toHaveLength(1);
  });
});

describe('sending email through Gmail', () => {
  it('sends queued emails as the organization, with HTML and plain text', async () => {
    await admin.post('/api/time-off').send({
      userId: people.ana.id,
      typeId: ctx.db.read((t) => t.timeOffTypes.all()[0]!.id),
      startDate: day(3),
      endDate: day(3),
      note: null,
    });
    expect(ctx.kicks()).toBeGreaterThan(0);
    expect(sendNow()).toBe(1);
    expect(ctx.env.sent).toEqual([
      expect.objectContaining({
        to: people.ana.email,
        name: 'My Team',
        subject: expect.stringContaining('Time off added'),
        htmlBody: expect.stringContaining('<html'),
        body: expect.stringContaining('Hi Ana'),
      }),
    ]);
    expect(email(people.ana.email)).toMatchObject({ status: 'sent', attempts: 1 });
    expect(sendNow()).toBe(0);
  });

  it('retries with backoff, then gives up after five attempts', async () => {
    ctx.env.failFor.add(people.bo.email);
    await admin
      .post(`/api/schedules/${main_}/shifts`)
      .send({ userId: people.bo.id, ...shiftOn(day(1)) });
    await admin.post(`/api/schedules/${main_}/publish`).send({});
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(sendNow()).toBe(0);
      const row = email(people.bo.email);
      expect(row).toMatchObject({ attempts: attempt, lastError: 'Service invoked too many times' });
      expect(row.status).toBe(attempt < 5 ? 'queued' : 'failed');
      if (attempt < 5) {
        // Not due again until the backoff is up.
        expect(Date.parse(row.runAfter)).toBeGreaterThan(Date.now());
        ctx.db.write((t) => t.notifications.update(row.id, { runAfter: hoursAgo(1) }));
      }
    }
    // An admin can retry it from the email log.
    ctx.env.failFor.clear();
    await admin.post(`/api/admin/notifications/${email(people.bo.email).id}/retry`).expect(204);
    expect(sendNow()).toBe(1);
    expect(email(people.bo.email).status).toBe('sent');
  });

  it('picks up emails left "sending" by a run that stopped, and waits for quota', async () => {
    await admin.post(`/api/users/${people.bo.id}`).send({});
    const stuck = ctx.db.write(
      (t) =>
        t.notifications.insert({
          kind: 'shift_reminder',
          toEmail: 'stuck@example.com',
          subject: 'Stuck',
          html: '<p>Hi</p>',
          text: 'Hi',
          status: 'sending',
          attempts: 1,
          lockedAt: hoursAgo(1),
          runAfter: hoursAgo(1),
        }).id,
    );
    ctx.env.quota = 0;
    expect(sendNow()).toBe(0);
    expect(ctx.db.read((t) => t.notifications.get(stuck)!.status)).toBe('queued');
    ctx.env.quota = 10;
    expect(sendNow()).toBe(1);
    expect(ctx.env.sent[0]!.to).toBe('stuck@example.com');
  });
});

describe('hourly jobs', () => {
  const runHourly = () => {
    activate(ctx.env);
    main.runHourlyJobs();
  };

  it('reminds people once about shifts still unconfirmed after the configured delay', async () => {
    const res = await admin
      .post(`/api/schedules/${main_}/shifts`)
      .send({ userId: people.ana.id, ...shiftOn(day(9)) })
      .expect(201);
    await admin.post(`/api/schedules/${main_}/publish`).send({}).expect(200);
    await clearEmails(ctx.db);
    runHourly();
    expect(await emails(ctx.db, { kind: 'shift_reminder' })).toHaveLength(0);
    ctx.db.write((t) => t.shifts.update(res.body.id, { publishedAt: hoursAgo(25) }));
    runHourly();
    const [reminder] = await emails(ctx.db, { kind: 'shift_reminder' });
    expect(reminder).toMatchObject({ toEmail: people.ana.email, shiftIds: [res.body.id] });
    // Sent right away by the same run, and not again next hour.
    expect(ctx.env.sent.some((m) => m.to === people.ana.email)).toBe(true);
    runHourly();
    expect(await emails(ctx.db, { kind: 'shift_reminder' })).toHaveLength(1);
  });

  it('deletes sent and failed emails older than the setting, never ones still going out', async () => {
    ctx.db.write((t) => {
      for (const [status, days] of [
        ['sent', 100],
        ['failed', 100],
        ['queued', 100],
        ['sent', 10],
      ] as const) {
        t.notifications.insert({
          kind: 'shift_reminder',
          toEmail: `${status}-${days}@example.com`,
          subject: 's',
          html: '',
          text: 't',
          status,
          createdAt: hoursAgo(days * 24),
          runAfter: new Date(Date.now() + 86_400_000).toISOString(),
        });
      }
    });
    runHourly();
    const left = (await emails(ctx.db)).map((e) => e.toEmail).sort();
    expect(left).toEqual(['queued-100@example.com', 'sent-10@example.com']);
  });

  it('saves lapsed swaps and started open shifts, and tidies up deleted rows', async () => {
    const shift = await admin
      .post(`/api/schedules/${main_}/shifts`)
      .send({ userId: people.ana.id, ...shiftOn(day(11)) });
    await admin.post(`/api/schedules/${main_}/publish`).send({});
    const swap: ShiftSwap = (
      await ana.post('/api/my/swaps').send({ shiftId: shift.body.id, recipientId: people.bo.id })
    ).body;
    ctx.db.write((t) =>
      t.shifts.update(shift.body.id, { publishedStartTime: hoursAgo(1), startTime: hoursAgo(1) }),
    );
    runHourly();
    expect(ctx.db.read((t) => t.swaps.get(swap.id)!.status)).toBe('expired');
    // Deletions leave blank rows; enough of them get compacted away.
    const sheet = ctx.env.book.getSheetByName('audit_log')!;
    ctx.db.write((t) => {
      for (let i = 0; i < 120; i++) t.audit.insert({ id: `9${i}`, action: 'x', entityType: 'x' });
      t.audit.insert({ id: '9999', action: 'kept', entityType: 'x' });
    });
    ctx.db.write((t) => {
      for (const a of t.audit.where((a) => a.action === 'x')) t.audit.delete(a.id);
    });
    const before = sheet.getLastRow();
    runHourly();
    expect(sheet.getLastRow()).toBeLessThan(before - 100);
    expect(ctx.db.read((t) => t.audit.all().map((a) => a.action))).toContain('kept');
  });
});

describe('the Sheet', () => {
  it('keeps text that looks like a formula as text', async () => {
    const notes = '=HYPERLINK("http://example.com") +1 -2 @me';
    const res = await admin
      .post(`/api/schedules/${main_}/shifts`)
      .send({ userId: people.bo.id, ...shiftOn(day(20)), notes })
      .expect(201);
    expect(res.body.notes).toBe(notes);
    const range = await admin.get(`/api/schedules/${main_}?from=${day(20)}&to=${day(20)}`);
    expect(range.body.shifts[0].notes).toBe(notes);
  });

  it('saves nothing from a request that fails part-way', async () => {
    const before = ctx.env.book.writes;
    const res = await admin
      .post(`/api/schedules/${main_}/shifts/bulk`)
      .send({ userId: 'not-an-id', shifts: [shiftOn(day(22))] });
    expect(res.status).toBe(400);
    expect(ctx.env.book.writes).toBe(before);
  });
});

describe('the web page', () => {
  it('opens the screen a link points at, already knowing who you are', async () => {
    activate(ctx.env);
    ctx.env.activeUser = people.ana.email;
    const page = main.doGet({
      pathInfo: 'confirm-shift/abc',
      queryString: 'ids=1,2',
      parameter: { ids: '1,2' },
    } as unknown as GoogleAppsScript.Events.DoGet) as unknown as {
      getContent(): string;
      title: string;
      meta: Record<string, string>;
    };
    const boot = JSON.parse(/window\.__TORETTO__=(.*)<\/script>/.exec(page.getContent())![1]!);
    expect(boot.path).toBe('/confirm-shift/abc?ids=1,2');
    expect(boot.bootstrap.body).toMatchObject({
      user: { email: people.ana.email },
      signIn: 'google',
      calendarFeed: false,
    });
    expect(page.title).toBe('My Team · Scheduling');
    expect(page.meta.viewport).toContain('width=device-width');
    // The /exec address is saved for links in emails sent by the timers.
    expect(ctx.env.properties.get('APP_URL')).toBe(ctx.env.appUrl);
  });

  it("tells someone who isn't on the People list to ask an admin", async () => {
    activate(ctx.env);
    ctx.env.activeUser = 'stranger@example.com';
    const res = JSON.parse(main.api('GET', '/bootstrap', null));
    expect(res.body).toMatchObject({ user: null, signedInAs: 'stranger@example.com' });
    expect(
      JSON.parse(main.api('GET', '/my/shifts?from=2026-01-01&to=2026-01-02', null)).status,
    ).toBe(401);
  });

  it('answers a batch of reads in one call', async () => {
    activate(ctx.env);
    ctx.env.activeUser = people.admin.email;
    const results = JSON.parse(
      main.apiBatch(
        JSON.stringify([
          ['GET', '/tiers'],
          ['GET', '/schedules'],
          ['GET', '/nope'],
        ]),
      ),
    );
    expect(results.map((r: { status: number }) => r.status)).toEqual([200, 200, 404]);
  });
});

describe('the built Code.gs', () => {
  it('runs in a bare JavaScript sandbox, like Apps Script', async () => {
    const code = await buildServer('0123abcd');
    const sandbox = vm.createContext({ console });
    installAppsScript(sandbox);
    const project = createEmulator();
    activate(project);
    vm.runInContext(code, sandbox, { filename: 'Code.gs' });
    for (const fn of ['doGet', 'api', 'apiBatch', 'setup', 'sendQueuedEmails', 'runHourlyJobs']) {
      expect(typeof sandbox[fn]).toBe('function');
    }
    expect(sandbox.setup()).toMatch(/^Setup done \(version 0123abcd\)\..*Time zones check out/);
    project.activeUser = project.owner;
    const boot = JSON.parse(sandbox.api('GET', '/bootstrap', null));
    expect(boot.body.user).toMatchObject({ role: 'admin', email: project.owner });
    const tier = JSON.parse(
      sandbox.api('POST', '/tiers', JSON.stringify({ name: 'Night crew', color: '#4f46e5' })),
    );
    expect(tier.status).toBe(201);
    const bad = JSON.parse(sandbox.api('POST', '/tiers', JSON.stringify({ name: '' })));
    expect(bad.status).toBe(400);

    // index.html has to come from the same build.
    const open = (version: string) => {
      project.files.set(
        'index',
        `<html><head><meta name="toretto-version" content="${version}" /></head>` +
          '<body><div id="root"></div><!--TORETTO_BOOT--></body></html>',
      );
      return sandbox.doGet({ pathInfo: '', queryString: '', parameter: {} }).getContent();
    };
    expect(open('0123abcd')).toContain('window.__TORETTO__=');
    const mismatch = open('ffff0000');
    expect(mismatch).not.toContain('window.__TORETTO__');
    expect(mismatch).toContain('Code.gs is version 0123abcd, but index.html is version ffff0000');
  });
});
