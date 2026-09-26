import type { Config } from '../config';
import { withTransaction, type Db } from '../db';
import type { Logger } from '../logger';
import { getSettings, zoneFor } from '../services/settings';
import { enqueueEmail } from './outbox';
import { reminderTemplate, type EmailShift } from './templates';
import type { Mailer } from './transport';

export const MAX_ATTEMPTS = 5;
/** Postgres NOTIFY channel used to wake a separate worker process. */
export const OUTBOX_CHANNEL = 'toretto_outbox';
/** Minutes to wait before retry n (1-based). */
const BACKOFF_MINUTES = [1, 5, 15, 60];
const STUCK_AFTER_MINUTES = 10;

interface ClaimedEmail {
  id: string;
  to_email: string;
  subject: string;
  html: string;
  text: string;
  attempts: number;
  created_at: string;
}

/**
 * Deliver up to `batchSize` queued emails. Safe to run from several processes
 * at once: rows are claimed with SKIP LOCKED, and each row is re-claimed just
 * before sending, so a row that another worker took over (because this one
 * looked stuck) is never sent twice. Returns how many were claimed.
 */
export async function processOutbox(
  db: Db,
  mailer: Mailer,
  logger: Logger,
  batchSize = 10,
): Promise<number> {
  // A worker that died mid-send leaves rows in 'sending'; retry them.
  await db.query(
    `UPDATE notifications SET status = 'queued', locked_at = NULL
      WHERE status = 'sending' AND locked_at < now() - make_interval(mins => $1)`,
    [STUCK_AFTER_MINUTES],
  );
  const { rows } = await db.query<ClaimedEmail>(
    `UPDATE notifications SET status = 'sending', locked_at = now(), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM notifications
         WHERE status = 'queued' AND run_after <= now()
         ORDER BY run_after
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING id, to_email, subject, html, text, attempts, created_at`,
    [batchSize],
  );
  // RETURNING has no order; deliver oldest first.
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const email of rows) {
    // `attempts` changes with every claim, so it identifies our claim. Refresh
    // the lock (we're alive) and skip the row if someone else took it over.
    const { rowCount: stillOurs } = await db.query(
      `UPDATE notifications SET locked_at = now()
        WHERE id = $1 AND status = 'sending' AND attempts = $2`,
      [email.id, email.attempts],
    );
    if (!stillOurs) continue;
    try {
      const { messageId } = await mailer.send({
        to: email.to_email,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
      await db.query(
        `UPDATE notifications
            SET status = 'sent', sent_at = now(), locked_at = NULL, last_error = NULL,
                provider_message_id = $3
          WHERE id = $1 AND attempts = $2`,
        [email.id, email.attempts, messageId],
      );
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      const giveUp = email.attempts >= MAX_ATTEMPTS;
      const delay = BACKOFF_MINUTES[Math.min(email.attempts, BACKOFF_MINUTES.length) - 1] ?? 60;
      logger.warn(
        `Email ${email.id} to ${email.to_email} failed (attempt ${email.attempts}/${MAX_ATTEMPTS})${giveUp ? ', giving up' : ''}: ${message}`,
      );
      await db.query(
        `UPDATE notifications
            SET status = $3, locked_at = NULL, last_error = $4,
                run_after = now() + make_interval(mins => $5)
          WHERE id = $1 AND attempts = $2`,
        [email.id, email.attempts, giveUp ? 'failed' : 'queued', message.slice(0, 1000), delay],
      );
    }
  }
  return rows.length;
}

interface ReminderRow {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  userTimezone: string | null;
  startTime: string;
  endTime: string;
  notes: string | null;
  labelName: string | null;
  labelColor: string | null;
  tierName: string;
  tierColor: string;
}

/**
 * Queue one reminder email per person whose published shifts are still
 * unconfirmed `reminder_hours` after publishing. Each shift is reminded once.
 */
export async function queueReminders(db: Db, config: Config, now = new Date()): Promise<number> {
  const settings = await getSettings(db);
  if (settings.reminderHours <= 0) return 0;
  return withTransaction(db, async (client) => {
    const { rows } = await client.query<ReminderRow>(
      `WITH due AS (
         UPDATE shifts s SET reminder_sent_at = $1
          WHERE s.id IN (
            SELECT s2.id FROM shifts s2
              JOIN users u2 ON u2.id = s2.published_user_id
             WHERE s2.published_at IS NOT NULL
               AND s2.deleted_at IS NULL
               AND s2.status = 'pending'
               AND s2.reminder_sent_at IS NULL
               AND s2.published_at <= $1::timestamptz - make_interval(hours => $2)
               AND s2.published_start_time > $1
               AND u2.deactivated_at IS NULL
             FOR UPDATE OF s2 SKIP LOCKED)
          RETURNING s.id, s.schedule_id, s.published_user_id, s.published_label_id,
                    s.published_start_time, s.published_end_time, s.published_notes)
       SELECT due.id, u.id AS "userId", u.name AS "userName", u.email AS "userEmail",
              u.timezone AS "userTimezone", due.published_start_time AS "startTime",
              due.published_end_time AS "endTime", due.published_notes AS notes,
              l.name AS "labelName", l.color AS "labelColor",
              t.name AS "tierName", t.color AS "tierColor"
         FROM due
         JOIN users u ON u.id = due.published_user_id
         JOIN schedules sc ON sc.id = due.schedule_id
         JOIN tiers t ON t.id = sc.tier_id
         LEFT JOIN labels l ON l.id = due.published_label_id
        ORDER BY due.published_start_time`,
      [now, settings.reminderHours],
    );
    const byUser = new Map<string, ReminderRow[]>();
    for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
    const ctx = { orgName: settings.orgName, appUrl: config.appUrl };
    for (const shifts of byUser.values()) {
      const first = shifts[0]!;
      const tz = zoneFor({ timezone: first.userTimezone }, settings);
      const emailShifts: EmailShift[] = shifts.map((s) => ({
        id: s.id,
        startTime: s.startTime,
        endTime: s.endTime,
        labelName: s.labelName,
        labelColor: s.labelColor,
        tierName: s.tierName,
        tierColor: s.tierColor,
        notes: s.notes,
        needsConfirmation: true,
      }));
      await enqueueEmail(client, {
        userId: first.userId,
        to: first.userEmail,
        kind: 'shift_reminder',
        email: reminderTemplate(ctx, { recipientName: first.userName, tz, shifts: emailShifts }),
        shiftIds: shifts.map((s) => s.id),
      });
    }
    return byUser.size;
  });
}

export async function cleanupExpired(db: Db): Promise<void> {
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  await db.query(`DELETE FROM auth_tokens WHERE expires_at < now() - interval '7 days'`);
}

export interface JobsReport {
  /** People who were sent a reminder. */
  reminders: number;
  /** Emails that delivery was attempted for. */
  emails: number;
}

export interface Jobs {
  /**
   * Send every email that is due. Concurrent calls share one run, and a call
   * made during a run makes it go around once more, so nothing queued in the
   * meantime is missed. Resolves with the number of emails attempted.
   */
  drainOutbox(): Promise<number>;
  /**
   * Periodic upkeep: queue due reminders, send due emails (including retries)
   * and delete expired sessions. Reminders run at most every few minutes and
   * cleanup hourly, unless `force` is set.
   */
  runDue(options?: { force?: boolean }): Promise<JobsReport>;
}

export function createJobs(deps: {
  db: Db;
  mailer: Mailer;
  logger: Logger;
  config: Config;
  /** Checked between batches; stop sending when it returns true. */
  shouldStop?: () => boolean;
  /** Don't start a new batch after this long (serverless time limits). */
  budgetMs?: number;
}): Jobs {
  const { db, mailer, logger, config, shouldStop = () => false, budgetMs = Infinity } = deps;
  const REMINDER_EVERY_MS = 5 * 60_000;
  const CLEANUP_EVERY_MS = 60 * 60_000;
  let lastReminders = 0;
  let lastCleanup = 0;
  let draining: Promise<number> | null = null;
  let again = false;

  function drainOutbox(): Promise<number> {
    if (draining) {
      again = true;
      return draining;
    }
    const until = Date.now() + budgetMs;
    const canContinue = () => !shouldStop() && Date.now() < until;
    if (!canContinue()) return Promise.resolve(0);
    draining = (async () => {
      let attempted = 0;
      try {
        do {
          again = false;
          let claimed: number;
          do {
            claimed = await processOutbox(db, mailer, logger);
            attempted += claimed;
          } while (claimed > 0 && canContinue());
          // No await between this check and clearing `draining`, so a call
          // either makes this run go around again or starts the next one.
        } while (again && canContinue());
      } finally {
        draining = null;
      }
      return attempted;
    })();
    return draining;
  }

  return {
    drainOutbox,
    async runDue({ force = false } = {}) {
      const now = Date.now();
      let reminders = 0;
      if (force || now - lastReminders >= REMINDER_EVERY_MS) {
        lastReminders = now;
        reminders = await queueReminders(db, config);
        if (reminders) logger.info(`Queued ${reminders} shift reminder email(s)`);
      }
      const emails = await drainOutbox();
      if (force || now - lastCleanup >= CLEANUP_EVERY_MS) {
        lastCleanup = now;
        await cleanupExpired(db);
      }
      return { reminders, emails };
    },
  };
}

export interface Worker {
  start(): void;
  stop(): Promise<void>;
  /** Process the queue soon (call after enqueueing emails). */
  kick(): void;
}

/** Long-running background worker: polls the outbox and runs periodic jobs. */
export function createWorker(deps: {
  db: Db;
  mailer: Mailer;
  logger: Logger;
  config: Config;
}): Worker {
  const { logger, config } = deps;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let rerun = false;
  let stopped = true;
  const jobs = createJobs({ ...deps, shouldStop: () => stopped });

  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), ms);
  };

  async function tick(): Promise<void> {
    timer = null;
    if (running) {
      rerun = true;
      return;
    }
    running = jobs
      .runDue()
      .then(() => undefined)
      .catch((err) => logger.error('Background worker error', err))
      .finally(() => {
        running = null;
      });
    await running;
    const again = rerun;
    rerun = false;
    schedule(again ? 0 : config.workerPollMs);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(0);
      logger.info(`Background worker started (transport: ${config.email.transport})`);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await running;
    },
    kick() {
      if (stopped) return;
      if (running) rerun = true;
      else schedule(25);
    },
  };
}
