import type { EmailShift } from '../../../server/src/email/templates';
import { reminderTemplate } from '../../../server/src/email/templates';
import { getSettings, iso, ms, tables, timeFormatFor, zoneFor, type Ctx } from '../core';
import { TABLES } from '../db/schema';
import { Db } from '../db/store';
import { appUrl } from '../env';
import { checkAppCalendar, forgetOldCalendarEvents, syncCalendars } from './calendar';
import { emailContext, enqueueEmail } from './mail';
import { settleOpenShifts } from './openShifts';
import { settleSwaps } from './swaps';

export const MAX_ATTEMPTS = 5;
/** Minutes to wait before retry n (1-based). */
const BACKOFF_MINUTES = [1, 5, 15, 60];
const STUCK_AFTER_MINUTES = 10;
/** Emails per run: sending takes about a second each, and a run can last six minutes. */
const BATCH = 40;

export function jobContext(db: Db): Ctx {
  return { db, now: db.now, user: null, email: '', appUrl: appUrl(), queued: 0 };
}

/**
 * Send queued emails through Gmail (MailApp), oldest first. Rows are claimed
 * under the lock, sent without it, then marked sent, or retried later.
 * Returns how many were sent.
 */
export function sendQueuedEmails(): number {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10_000)) return 0;
  let claimed: { id: string; to: string; subject: string; html: string; text: string }[];
  let senderName: string;
  try {
    const db = new Db();
    const t = tables(db);
    const now = ms(db.now);
    // A run that stopped mid-send leaves rows in 'sending': retry them.
    for (const n of t.notifications.where(
      (n) =>
        n.status === 'sending' &&
        (!n.lockedAt || now - ms(n.lockedAt) > STUCK_AFTER_MINUTES * 60_000),
    )) {
      t.notifications.update(n.id, { status: 'queued', lockedAt: null });
    }
    const quota = MailApp.getRemainingDailyQuota();
    const due = t.notifications
      .where((n) => n.status === 'queued' && ms(n.runAfter) <= now)
      .sort((a, b) => ms(a.runAfter) - ms(b.runAfter) || ms(a.createdAt) - ms(b.createdAt))
      .slice(0, Math.max(0, Math.min(BATCH, quota)));
    for (const n of due) {
      t.notifications.update(n.id, {
        status: 'sending',
        lockedAt: db.now,
        attempts: n.attempts + 1,
      });
    }
    claimed = due.map((n) => ({
      id: n.id,
      to: n.toEmail,
      subject: n.subject,
      html: n.html,
      text: n.text,
    }));
    senderName = getSettings(db).orgName;
    db.commit();
  } finally {
    lock.releaseLock();
  }
  if (!claimed.length) return 0;

  const results = claimed.map((email) => {
    try {
      MailApp.sendEmail({
        to: email.to,
        subject: email.subject,
        body: email.text,
        ...(email.html ? { htmlBody: email.html } : {}),
        name: senderName,
      });
      return { id: email.id, error: null };
    } catch (err) {
      return { id: email.id, error: (err as Error)?.message ?? String(err) };
    }
  });

  lock.waitLock(30_000);
  try {
    const db = new Db();
    const t = tables(db);
    for (const result of results) {
      const n = t.notifications.get(result.id);
      if (!n || n.status !== 'sending') continue;
      if (!result.error) {
        t.notifications.update(n.id, {
          status: 'sent',
          sentAt: db.now,
          lockedAt: null,
          lastError: null,
        });
        continue;
      }
      const giveUp = n.attempts >= MAX_ATTEMPTS;
      const delay = BACKOFF_MINUTES[Math.min(n.attempts, BACKOFF_MINUTES.length) - 1] ?? 60;
      console.warn(`Email to ${n.toEmail} failed (attempt ${n.attempts}): ${result.error}`);
      t.notifications.update(n.id, {
        status: giveUp ? 'failed' : 'queued',
        lockedAt: null,
        lastError: result.error.slice(0, 1000),
        runAfter: iso(ms(db.now) + delay * 60_000),
      });
    }
    db.commit();
  } finally {
    lock.releaseLock();
  }
  return results.filter((r) => !r.error).length;
}

/**
 * One reminder email per person whose published shifts are still unconfirmed
 * `reminderHours` after publishing. Each shift is reminded once.
 */
export function queueReminders(ctx: Ctx): number {
  const settings = getSettings(ctx.db);
  if (settings.reminderHours <= 0) return 0;
  const t = tables(ctx.db);
  const now = ms(ctx.now);
  const cutoff = now - settings.reminderHours * 3_600_000;
  const due = t.shifts
    .where((s) => {
      if (!s.publishedAt || s.deletedAt || s.status !== 'pending' || s.reminderSentAt) return false;
      if (ms(s.publishedAt) > cutoff || ms(s.publishedStartTime!) <= now) return false;
      const person = t.users.get(s.publishedUserId);
      return !!person && !person.deactivatedAt;
    })
    .sort((a, b) => ms(a.publishedStartTime!) - ms(b.publishedStartTime!));
  const byUser = new Map<string, typeof due>();
  for (const s of due) {
    t.shifts.update(s.id, { reminderSentAt: ctx.now });
    byUser.set(s.publishedUserId!, [...(byUser.get(s.publishedUserId!) ?? []), s]);
  }
  for (const [userId, shifts] of byUser) {
    const person = t.users.get(userId)!;
    const tier = t.tiers.get(person.tierId);
    const emailShifts: EmailShift[] = shifts.map((s) => {
      const label = t.labels.get(s.publishedLabelId);
      return {
        id: s.id,
        startTime: s.publishedStartTime!,
        endTime: s.publishedEndTime!,
        labelName: label?.name ?? null,
        color: label?.color ?? tier?.color ?? null,
        notes: s.publishedNotes,
        needsConfirmation: true,
      };
    });
    enqueueEmail(ctx, {
      userId,
      to: person.email,
      kind: 'shift_reminder',
      email: reminderTemplate(emailContext(ctx), {
        recipientName: person.name,
        tz: zoneFor(person, settings),
        timeFormat: timeFormatFor(person, settings),
        shifts: emailShifts,
      }),
      shiftIds: shifts.map((s) => s.id),
    });
  }
  return byUser.size;
}

/** Emails older than the organization keeps them (never ones still waiting to go). */
export function deleteOldEmails(ctx: Ctx): number {
  const { emailRetentionDays } = getSettings(ctx.db);
  if (emailRetentionDays === null) return 0;
  const cutoff = ms(ctx.now) - emailRetentionDays * 86_400_000;
  const t = tables(ctx.db);
  const old = t.notifications.where(
    (n) => (n.status === 'sent' || n.status === 'failed') && ms(n.createdAt) < cutoff,
  );
  for (const n of old) t.notifications.delete(n.id);
  return old.length;
}

/** Rewrite tabs that deletions left full of blank rows. */
export function compactTables(db: Db): void {
  for (const def of TABLES) {
    const table = db.table(def as never) as {
      all(): unknown[];
      blankRows(): number;
      compact(): number;
    };
    const blanks = table.blankRows();
    if (blanks > 50 && blanks > table.all().length / 4) table.compact();
  }
}

/** Hourly: lapse stale swaps and open shifts, queue reminders, clear old emails, tidy tabs. */
export function runHourlyJobs(): void {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30_000)) return;
  try {
    const db = new Db();
    const ctx = jobContext(db);
    settleSwaps(ctx);
    settleOpenShifts(ctx);
    queueReminders(ctx);
    deleteOldEmails(ctx);
    forgetOldCalendarEvents(db);
    checkAppCalendar(db);
    db.commit();
    compactTables(new Db());
  } finally {
    lock.releaseLock();
  }
  sendQueuedEmails();
  try {
    syncCalendars();
  } catch (err) {
    console.error(`Google Calendar: ${err instanceof Error ? err.message : String(err)}`);
  }
}
