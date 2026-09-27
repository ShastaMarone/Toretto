import { addDays } from '@shared/time';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { enqueueEmail } from '../src/email/outbox';
import type { Mailer, OutgoingEmail } from '../src/email/transport';
import {
  cleanupExpired,
  createJobs,
  createWorker,
  MAX_ATTEMPTS,
  processOutbox,
  queueReminders,
} from '../src/email/worker';
import { createLogger } from '../src/logger';
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
  type TestContext,
} from './helpers';

let ctx: TestContext;
const silent = createLogger('silent');

function fakeMailer(opts: { fail?: boolean } = {}) {
  const sent: OutgoingEmail[] = [];
  const mailer: Mailer = {
    async send(message) {
      if (opts.fail) throw new Error('SMTP is down');
      sent.push(message);
      return { messageId: `msg-${sent.length}` };
    },
  };
  return { mailer, sent };
}

const email = { subject: 'Hello', html: '<p>Hello</p>', text: 'Hello' };

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(() => clearEmails(ctx.db));

describe('email outbox', () => {
  it('delivers queued emails and records the provider id', async () => {
    await enqueueEmail(ctx.db, { userId: null, to: 'a@example.com', kind: 'invite', email });
    await enqueueEmail(ctx.db, { userId: null, to: 'b@example.com', kind: 'invite', email });
    const { mailer, sent } = fakeMailer();
    expect(await processOutbox(ctx.db, mailer, silent)).toBe(2);
    expect(sent.map((m) => m.to).sort()).toEqual(['a@example.com', 'b@example.com']);
    const { rows } = await ctx.db.query(
      'SELECT status, provider_message_id, sent_at FROM notifications',
    );
    expect(rows.every((r) => r.status === 'sent' && r.provider_message_id && r.sent_at)).toBe(true);
    expect(await processOutbox(ctx.db, mailer, silent)).toBe(0);
  });

  it('retries with backoff and gives up after the last attempt', async () => {
    const id = await enqueueEmail(ctx.db, {
      userId: null,
      to: 'c@example.com',
      kind: 'invite',
      email,
    });
    const { mailer } = fakeMailer({ fail: true });
    await processOutbox(ctx.db, mailer, silent);
    let { rows } = await ctx.db.query(
      `SELECT status, attempts, last_error, run_after > now() AS later FROM notifications WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toMatchObject({
      status: 'queued',
      attempts: 1,
      last_error: 'SMTP is down',
      later: true,
    });

    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await ctx.db.query('UPDATE notifications SET run_after = now() WHERE id = $1', [id]);
      await processOutbox(ctx.db, mailer, silent);
    }
    ({ rows } = await ctx.db.query('SELECT status, attempts FROM notifications WHERE id = $1', [
      id,
    ]));
    expect(rows[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });

    // Admins can retry failed emails from the email log.
    const admin = await createUser(ctx.db, { name: 'Retry Admin', role: 'admin' });
    const agent = ctx.agent();
    await login(agent, admin.email);
    await agent.post(`/api/admin/notifications/${id}/retry`).expect(204);
    const ok = fakeMailer();
    await processOutbox(ctx.db, ok.mailer, silent);
    expect(ok.sent.map((m) => m.to)).toContain('c@example.com');
  });

  it('recovers emails stuck in "sending" after a crash', async () => {
    const id = await enqueueEmail(ctx.db, {
      userId: null,
      to: 'd@example.com',
      kind: 'invite',
      email,
    });
    await ctx.db.query(
      `UPDATE notifications SET status = 'sending', locked_at = now() - interval '11 minutes' WHERE id = $1`,
      [id],
    );
    const { mailer, sent } = fakeMailer();
    await processOutbox(ctx.db, mailer, silent);
    expect(sent.map((m) => m.to)).toEqual(['d@example.com']);
  });

  it('never re-sends rows another worker took over while this one looked stuck', async () => {
    const first = await enqueueEmail(ctx.db, {
      userId: null,
      to: 'slow@example.com',
      kind: 'invite',
      email,
    });
    const second = await enqueueEmail(ctx.db, {
      userId: null,
      to: 'next@example.com',
      kind: 'invite',
      email,
    });
    // The slow one is older, so worker A sends it first.
    await ctx.db.query(
      `UPDATE notifications SET created_at = created_at + interval '1 second' WHERE id = $1`,
      [second],
    );
    let release!: () => void;
    const hung = new Promise<void>((resolve) => (release = resolve));
    const slowSent: string[] = [];
    const slow: Mailer = {
      async send(message) {
        if (message.to === 'slow@example.com') await hung;
        slowSent.push(message.to);
        return { messageId: 'slow' };
      },
    };
    // Worker A claims both and hangs on the first send…
    const workerA = processOutbox(ctx.db, slow, silent);
    await new Promise((r) => setTimeout(r, 100));
    // …long enough that worker B treats the batch as stuck and delivers it.
    await ctx.db.query(
      `UPDATE notifications SET locked_at = now() - interval '11 minutes' WHERE id = ANY($1)`,
      [[first, second]],
    );
    const b = fakeMailer();
    await processOutbox(ctx.db, b.mailer, silent);
    expect(b.sent.map((m) => m.to).sort()).toEqual(['next@example.com', 'slow@example.com']);

    release();
    await workerA;
    // A finishes its in-flight send, but must not touch the second email or B's results.
    expect(slowSent).toEqual(['slow@example.com']);
    const { rows } = await ctx.db.query(
      `SELECT status, provider_message_id FROM notifications WHERE id = ANY($1)`,
      [[first, second]],
    );
    expect(rows.map((r) => r.status)).toEqual(['sent', 'sent']);
    expect(rows.every((r) => r.provider_message_id !== 'slow')).toBe(true);
  });

  it('runs in the background and wakes up when kicked', async () => {
    const { mailer, sent } = fakeMailer();
    const worker = createWorker({
      db: ctx.db,
      mailer,
      logger: silent,
      config: { ...ctx.config, workerPollMs: 60_000 },
    });
    worker.start();
    try {
      await new Promise((r) => setTimeout(r, 100));
      await enqueueEmail(ctx.db, { userId: null, to: 'e@example.com', kind: 'invite', email });
      worker.kick();
      for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(sent.map((m) => m.to)).toEqual(['e@example.com']);
    } finally {
      await worker.stop();
    }
  });
});

describe('confirmation reminders', () => {
  it('reminds people once about shifts still unconfirmed after the configured delay', async () => {
    const tier = await createTier(ctx.db, 'Tier R');
    const adminUser = await createUser(ctx.db, { name: 'Rem Admin', role: 'admin' });
    const pat = await createUser(ctx.db, { name: 'Pat Pending', tierId: tier });
    const cora = await createUser(ctx.db, { name: 'Cora Confirmed', tierId: tier });
    const admin = ctx.agent();
    await login(admin, adminUser.email);
    const monday = nextMonday();
    const id = await defaultScheduleId(ctx.db);
    for (const [user, d] of [
      [pat, 0],
      [pat, 1],
      [cora, 0],
    ] as const) {
      await admin
        .post(`/api/schedules/${id}/shifts`)
        .send({ userId: user.id, ...shiftOn(addDays(monday, d)) })
        .expect(201);
    }
    await admin.post(`/api/schedules/${id}/publish`).send({}).expect(200);
    const coraAgent = ctx.agent();
    await login(coraAgent, cora.email);
    await coraAgent.post('/api/my/shifts/confirm').send({}).expect(200);
    await clearEmails(ctx.db);

    // Too soon: nothing yet.
    expect(await queueReminders(ctx.db, ctx.config)).toBe(0);

    const later = new Date(Date.now() + 25 * 3_600_000);
    expect(await queueReminders(ctx.db, ctx.config, later)).toBe(1);
    const [reminder] = await emails(ctx.db, { kind: 'shift_reminder' });
    expect(reminder!.toEmail).toBe(pat.email);
    expect(reminder!.subject).toBe('Reminder: please confirm your 2 upcoming shifts');
    expect(reminder!.shiftIds).toHaveLength(2);

    // Only once per shift.
    expect(await queueReminders(ctx.db, ctx.config, later)).toBe(0);

    // A re-published change resets the reminder.
    await ctx.db.query(`UPDATE org_settings SET reminder_hours = 0`);
    expect(await queueReminders(ctx.db, ctx.config, new Date(Date.now() + 100 * 3_600_000))).toBe(
      0,
    );
  });
});

describe('email log retention', () => {
  async function logged(to: string, status: string, daysAgo: number) {
    await enqueueEmail(ctx.db, { userId: null, to, kind: 'invite', email });
    await ctx.db.query(
      `UPDATE notifications SET status = $2, created_at = now() - make_interval(days => $3)
        WHERE to_email = $1`,
      [to, status, daysAgo],
    );
  }
  const remaining = async () =>
    (await emails(ctx.db)).map((e) => e.toEmail).sort((a, b) => a.localeCompare(b));

  it('deletes sent and failed emails older than the setting, never ones still going out', async () => {
    await logged('old-sent@example.com', 'sent', 91);
    await logged('old-failed@example.com', 'failed', 200);
    await logged('old-queued@example.com', 'queued', 120);
    await logged('old-sending@example.com', 'sending', 120);
    await logged('recent@example.com', 'sent', 89);
    await cleanupExpired(ctx.db);
    expect(await remaining()).toEqual([
      'old-queued@example.com',
      'old-sending@example.com',
      'recent@example.com',
    ]);
  });

  it('keeps everything when set to forever, and follows a shorter setting', async () => {
    await logged('year@example.com', 'sent', 400);
    await logged('month@example.com', 'sent', 40);
    await ctx.db.query('UPDATE org_settings SET email_retention_days = NULL');
    await cleanupExpired(ctx.db);
    expect(await remaining()).toEqual(['month@example.com', 'year@example.com']);
    await ctx.db.query('UPDATE org_settings SET email_retention_days = 30');
    await cleanupExpired(ctx.db);
    expect(await remaining()).toEqual([]);
    await ctx.db.query('UPDATE org_settings SET email_retention_days = 90');
  });
});

describe('scheduled jobs (serverless)', () => {
  it('shares one outbox run between callers and goes around again for late arrivals', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sent: string[] = [];
    const mailer: Mailer = {
      async send(message) {
        if (message.to === 'first@example.com') await gate;
        sent.push(message.to);
        return { messageId: message.to };
      },
    };
    const jobs = createJobs({ db: ctx.db, mailer, logger: silent, config: ctx.config });
    await enqueueEmail(ctx.db, { userId: null, to: 'first@example.com', kind: 'invite', email });
    const a = jobs.drainOutbox();
    for (let i = 0; i < 50 && !(await isSending(ctx)); i++) await pause(10);
    // Queued while the first email is still being sent.
    await enqueueEmail(ctx.db, { userId: null, to: 'late@example.com', kind: 'invite', email });
    const b = jobs.drainOutbox();
    expect(b).toBe(a);
    release();
    expect(await a).toBe(2);
    expect(sent).toEqual(['first@example.com', 'late@example.com']);
  });

  it('stops when asked and can run again afterwards', async () => {
    const { mailer, sent } = fakeMailer();
    let stop = true;
    const jobs = createJobs({
      db: ctx.db,
      mailer,
      logger: silent,
      config: ctx.config,
      shouldStop: () => stop,
    });
    await enqueueEmail(ctx.db, { userId: null, to: 'wait@example.com', kind: 'invite', email });
    expect(await jobs.drainOutbox()).toBe(0);
    expect(sent).toEqual([]);
    stop = false;
    expect(await jobs.drainOutbox()).toBe(1);
    expect(sent.map((m) => m.to)).toEqual(['wait@example.com']);
  });

  it('runs reminders and sends due email from GET /api/cron, given the secret', async () => {
    await ctx.db.query('UPDATE org_settings SET reminder_hours = 24');
    const tier = await createTier(ctx.db, 'Tier C');
    const adminUser = await createUser(ctx.db, { name: 'Cron Admin', role: 'admin' });
    const quinn = await createUser(ctx.db, { name: 'Quinn Quiet', tierId: tier });
    const admin = ctx.agent();
    await login(admin, adminUser.email);
    const monday = nextMonday();
    const main = await defaultScheduleId(ctx.db);
    await admin
      .post(`/api/schedules/${main}/shifts`)
      .send({ userId: quinn.id, ...shiftOn(monday) })
      .expect(201);
    await admin.post(`/api/schedules/${main}/publish`).send({}).expect(200);
    // Published two days ago and still unconfirmed.
    await ctx.db.query(
      `UPDATE shifts SET published_at = now() - interval '48 hours' WHERE published_user_id = $1`,
      [quinn.id],
    );
    await clearEmails(ctx.db);
    await enqueueEmail(ctx.db, { userId: null, to: 'retry@example.com', kind: 'invite', email });

    const { mailer, sent } = fakeMailer();
    const jobs = createJobs({ db: ctx.db, mailer, logger: silent, config: ctx.config });
    const secret = 'a-long-enough-cron-secret';
    const app = createApp({
      config: { ...ctx.config, cronSecret: secret },
      db: ctx.db,
      logger: silent,
      kick: () => undefined,
      runJobs: () => jobs.runDue({ force: true }),
    });

    await request(app).get('/api/cron').expect(401);
    await request(app).get('/api/cron').set('Authorization', 'Bearer wrong').expect(401);
    expect(sent).toEqual([]);
    const res = await request(app)
      .get('/api/cron')
      .set('Authorization', `Bearer ${secret}`)
      .expect(200);
    expect(res.body).toEqual({ reminders: 1, emails: 2 });
    expect(sent.map((m) => m.to).sort()).toEqual([quinn.email, 'retry@example.com'].sort());
  });

  it('has no cron endpoint unless a secret is configured', async () => {
    const app = createApp({
      config: ctx.config,
      db: ctx.db,
      logger: silent,
      kick: () => undefined,
      runJobs: async () => ({ reminders: 0, emails: 0 }),
    });
    await request(app).get('/api/cron').set('Authorization', 'Bearer anything').expect(404);
  });
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function isSending(context: TestContext): Promise<boolean> {
  const { rows } = await context.db.query(
    `SELECT 1 FROM notifications WHERE status = 'sending' LIMIT 1`,
  );
  return rows.length > 0;
}
