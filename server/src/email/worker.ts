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
}

/**
 * Deliver up to `batchSize` queued emails. Safe to run from several processes
 * at once: rows are claimed with SKIP LOCKED. Returns how many were attempted.
 */
export async function processOutbox(
  db: Db,
  mailer: Mailer,
  logger: Logger,
  batchSize = 20,
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
      RETURNING id, to_email, subject, html, text, attempts`,
    [batchSize],
  );
  for (const email of rows) {
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
                provider_message_id = $2
          WHERE id = $1`,
        [email.id, messageId],
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
            SET status = $2, locked_at = NULL, last_error = $3,
                run_after = now() + make_interval(mins => $4)
          WHERE id = $1`,
        [email.id, giveUp ? 'failed' : 'queued', message.slice(0, 1000), delay],
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

export interface Worker {
  start(): void;
  stop(): Promise<void>;
  /** Process the queue soon (call after enqueueing emails). */
  kick(): void;
}

export function createWorker(deps: {
  db: Db;
  mailer: Mailer;
  logger: Logger;
  config: Config;
}): Worker {
  const { db, mailer, logger, config } = deps;
  const REMINDER_EVERY_MS = 5 * 60_000;
  const CLEANUP_EVERY_MS = 60 * 60_000;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let rerun = false;
  let stopped = true;
  let lastReminders = 0;
  let lastCleanup = 0;

  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), ms);
  };

  async function runOnce(): Promise<void> {
    const now = Date.now();
    if (now - lastReminders >= REMINDER_EVERY_MS) {
      lastReminders = now;
      const queued = await queueReminders(db, config);
      if (queued) logger.info(`Queued ${queued} shift reminder email(s)`);
    }
    // Drain everything that is due.
    while (!stopped && (await processOutbox(db, mailer, logger)) > 0) {
      /* keep going */
    }
    if (now - lastCleanup >= CLEANUP_EVERY_MS) {
      lastCleanup = now;
      await cleanupExpired(db);
    }
  }

  async function tick(): Promise<void> {
    timer = null;
    if (running) {
      rerun = true;
      return;
    }
    running = runOnce()
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
