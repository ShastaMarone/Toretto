import type {
  AdminOverview,
  AuditEntry,
  MailboxMessage,
  NotificationEntry,
  OrgSettings,
  UnconfirmedShift,
} from '@shared/types';
import { todayIn } from '@shared/time';
import { Router } from 'express';
import { z } from 'zod';
import type { Queryable } from '../db';
import type { AppDeps } from '../deps';
import { SENSITIVE_KINDS } from '../email/outbox';
import { badRequest, notFound } from '../errors';
import { parse, zDate, zId, zIdParam, zName, zText, zTimezone } from '../lib/validation';
import { audit } from '../services/audit';
import { listSchedules } from '../services/schedules';
import { getSettings } from '../services/settings';
import { addTimeOffForPerson, listTimeOff, reviewTimeOff } from '../services/timeOff';
import { SHIFT_VIEW_SQL } from '../services/views';

async function listActivity(db: Queryable, limit: number, before?: number): Promise<AuditEntry[]> {
  const { rows } = await db.query<AuditEntry>(
    `SELECT a.id, a.actor_id AS "actorId", u.name AS "actorName", a.action,
            a.entity_type AS "entityType", a.entity_id AS "entityId", a.details,
            a.created_at AS "createdAt"
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE ($1::bigint IS NULL OR a.id < $1)
      ORDER BY a.id DESC
      LIMIT $2`,
    [before ?? null, limit],
  );
  return rows;
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function adminRoutes({ db, kick }: AppDeps): Router {
  const r = Router();

  r.get('/overview', async (_req, res) => {
    const settings = await getSettings(db);
    const today = todayIn(settings.timezone);
    const { rows: counts } = await db.query<{
      pendingTimeOff: number;
      peopleWithoutTier: number;
      invitedPeople: number;
      failedEmails: number;
    }>(
      `SELECT (SELECT count(*)::int FROM time_off_requests WHERE status = 'pending') AS "pendingTimeOff",
              (SELECT count(*)::int FROM users WHERE tier_id IS NULL AND deactivated_at IS NULL) AS "peopleWithoutTier",
              (SELECT count(*)::int FROM users WHERE email_verified_at IS NULL AND deactivated_at IS NULL) AS "invitedPeople",
              (SELECT count(*)::int FROM notifications
                WHERE status = 'failed' AND created_at > now() - interval '7 days') AS "failedEmails"`,
    );
    const schedules = await listSchedules(db, { endingAfter: today });
    const { rows: unconfirmedSoon } = await db.query<UnconfirmedShift>(
      `SELECT v.*, u.name AS "userName" FROM (
         ${SHIFT_VIEW_SQL}
           AND s.status = 'pending' AND s.deleted_at IS NULL
           AND s.published_start_time > now()
           AND s.published_start_time < now() + interval '7 days'
       ) v JOIN users u ON u.id = v."userId"
       ORDER BY v."startTime"
       LIMIT 500`,
    );
    const overview: AdminOverview = {
      ...counts[0]!,
      drafts: schedules.filter((s) => s.status === 'draft').reverse(),
      withChanges: schedules
        .filter((s) => s.status === 'published' && s.pendingChanges > 0)
        .reverse(),
      upcoming: schedules.filter((s) => s.status === 'published').reverse(),
      unconfirmedSoon,
      recentActivity: await listActivity(db, 8),
    };
    res.json(overview);
  });

  r.get('/activity', async (req, res) => {
    const { limit, before } = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    res.json(await listActivity(db, limit, before));
  });

  r.get('/notifications', async (req, res) => {
    const { limit, status } = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(100),
        status: z.enum(['queued', 'sending', 'sent', 'failed']).optional(),
      }),
      req.query,
    );
    const { rows } = await db.query<NotificationEntry>(
      `SELECT n.id, n.kind, n.to_email AS "toEmail", u.name AS "userName", n.subject, n.status,
              n.attempts, n.last_error AS "lastError", n.sent_at AS "sentAt", n.created_at AS "createdAt"
         FROM notifications n LEFT JOIN users u ON u.id = n.user_id
        WHERE ($1::text IS NULL OR n.status = $1)
        ORDER BY n.created_at DESC
        LIMIT $2`,
      [status ?? null, limit],
    );
    res.json(rows);
  });

  r.get('/notifications/:id', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const { rows } = await db.query<NotificationEntry & { html: string | null }>(
      `SELECT n.id, n.kind, n.to_email AS "toEmail", u.name AS "userName", n.subject, n.status,
              n.attempts, n.last_error AS "lastError", n.sent_at AS "sentAt", n.created_at AS "createdAt",
              CASE WHEN n.kind = ANY($2) THEN NULL ELSE n.html END AS html
         FROM notifications n LEFT JOIN users u ON u.id = n.user_id
        WHERE n.id = $1`,
      [id, [...SENSITIVE_KINDS]],
    );
    if (!rows[0]) throw notFound('Email');
    res.json(rows[0]);
  });

  r.post('/notifications/:id/retry', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const { rowCount } = await db.query(
      `UPDATE notifications SET status = 'queued', attempts = 0, run_after = now(), last_error = NULL
        WHERE id = $1 AND status = 'failed'`,
      [id],
    );
    if (!rowCount) throw badRequest('Only failed emails can be retried');
    kick();
    res.status(204).end();
  });

  r.get('/settings', async (_req, res) => {
    res.json(await getSettings(db));
  });

  r.patch('/settings', async (req, res) => {
    const body = parse(
      z.object({
        orgName: zName('Organization name', 80).optional(),
        timezone: zTimezone.optional(),
        weekStartsOn: z.union([z.literal(0), z.literal(1)]).optional(),
        reminderHours: z.number().int().min(0).max(336).optional(),
        selfSignup: z.boolean().optional(),
        allowedDomains: z
          .array(
            z
              .string()
              .trim()
              .toLowerCase()
              .transform((d) => d.replace(/^@/, '')),
          )
          .max(20)
          .optional(),
      }),
      req.body,
    );
    const domains = body.allowedDomains?.filter(Boolean);
    const invalid = domains?.find((d) => !DOMAIN.test(d));
    if (invalid)
      throw badRequest(`"${invalid}" is not a valid domain`, { allowedDomains: 'Invalid domain' });
    await db.query(
      `UPDATE org_settings
          SET org_name = COALESCE($1, org_name), timezone = COALESCE($2, timezone),
              week_starts_on = COALESCE($3, week_starts_on), reminder_hours = COALESCE($4, reminder_hours),
              self_signup = COALESCE($5, self_signup), allowed_domains = COALESCE($6, allowed_domains)`,
      [
        body.orgName ?? null,
        body.timezone ?? null,
        body.weekStartsOn ?? null,
        body.reminderHours ?? null,
        body.selfSignup ?? null,
        domains ? [...new Set(domains)] : null,
      ],
    );
    await audit(db, req.user!.id, 'settings.updated', { type: 'org' }, body);
    const settings: OrgSettings = await getSettings(db);
    res.json(settings);
  });

  return r;
}

/** Admin-only: review and record time off. */
export function timeOffAdminRoutes({ db, config, kick }: AppDeps): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const query = parse(
      z.object({
        status: z.enum(['pending', 'approved', 'denied', 'cancelled', 'all']).default('all'),
        from: zDate.optional(),
        to: zDate.optional(),
        userId: zId.optional(),
      }),
      req.query,
    );
    res.json(await listTimeOff(db, query));
  });

  r.post('/', async (req, res) => {
    const body = parse(
      z.object({ userId: zId, typeId: zId, startDate: zDate, endDate: zDate, note: zText(500) }),
      req.body,
    );
    const { userId, ...input } = body;
    const request = await addTimeOffForPerson(db, config, req.user!, userId, input);
    kick();
    res.status(201).json(request);
  });

  for (const [path, decision] of [
    ['approve', 'approved'],
    ['deny', 'denied'],
  ] as const) {
    r.post(`/:id/${path}`, async (req, res) => {
      const { id } = parse(zIdParam, req.params);
      const { note } = parse(z.object({ note: zText(500) }), req.body ?? {});
      const request = await reviewTimeOff(db, config, req.user!, id, decision, note);
      kick();
      res.json(request);
    });
  }

  return r;
}

/** Development only: read every queued/sent email, including sign-in links. */
export function devRoutes({ db, config }: AppDeps): Router {
  const r = Router();
  r.get('/mailbox', async (_req, res) => {
    if (!config.devMailbox) throw notFound('Page');
    const { rows } = await db.query<MailboxMessage>(
      `SELECT id, kind, to_email AS "toEmail", subject, html, text, status, created_at AS "createdAt"
         FROM notifications ORDER BY created_at DESC LIMIT 100`,
    );
    res.json(rows);
  });
  return r;
}
