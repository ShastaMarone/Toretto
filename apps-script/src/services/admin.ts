import { addDays, dayRangeToUtc, startOfWeek, todayIn } from '@shared/time';
import type {
  AdminOverview,
  AuditEntry,
  NotificationEntry,
  OrgSettings,
  ShiftView,
  UnconfirmedShift,
} from '@shared/types';
import { SENSITIVE_KINDS } from '../../../server/src/email/outbox';
import { badRequest, notFound } from '../../../server/src/errors';
import {
  audit,
  DEFAULT_SETTINGS,
  getSettings,
  ms,
  ORG_ID,
  shiftView,
  tables,
  type Ctx,
} from '../core';
import type { NotificationRow, OrgSettingsRow } from '../db/schema';
import { listSchedules } from './schedules';

export function listActivity(ctx: Ctx, limit: number, before?: number): AuditEntry[] {
  const t = tables(ctx.db);
  return t.audit
    .all()
    .map((a) => ({ a, id: Number(a.id) }))
    .filter(({ id }) => before === undefined || id < before)
    .sort((x, y) => y.id - x.id)
    .slice(0, limit)
    .map(({ a, id }) => ({
      id,
      actorId: a.actorId,
      actorName: t.users.get(a.actorId)?.name ?? null,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      details: a.details ?? {},
      createdAt: a.createdAt,
    }));
}

export function overview(ctx: Ctx): AdminOverview {
  const t = tables(ctx.db);
  const settings = getSettings(ctx.db);
  const today = todayIn(settings.timezone);
  const now = ms(ctx.now);
  const users = t.users.all();
  const weekStarts = [0, 7, 14, 21].map((d) =>
    addDays(startOfWeek(today, settings.weekStartsOn), d),
  );
  const published = t.shifts.where((s) => s.publishedAt !== null);
  const weeks = weekStarts.map((startDate) => {
    const { from, to } = dayRangeToUtc(startDate, addDays(startDate, 6), settings.timezone);
    const inWeek = published.filter(
      (s) => ms(s.publishedStartTime!) >= ms(from) && ms(s.publishedStartTime!) < ms(to),
    );
    return {
      startDate,
      endDate: addDays(startDate, 6),
      total: inWeek.length,
      confirmed: inWeek.filter((s) => s.status === 'confirmed').length,
    };
  });
  const unconfirmedSoon: UnconfirmedShift[] = published
    .filter(
      (s) =>
        s.status === 'pending' &&
        !s.deletedAt &&
        ms(s.publishedStartTime!) > now &&
        ms(s.publishedStartTime!) < now + 7 * 86_400_000,
    )
    .sort((a, b) => ms(a.publishedStartTime!) - ms(b.publishedStartTime!))
    .slice(0, 500)
    .map((s) => shiftView(ctx.db, s))
    .filter((v): v is ShiftView => v !== null)
    .map((v) => ({ ...v, userName: t.users.get(v.userId)?.name ?? '' }));
  return {
    pendingTimeOff: t.timeOff.where((r) => r.status === 'pending').length,
    peopleWithoutTier: users.filter((u) => !u.tierId && !u.deactivatedAt).length,
    invitedPeople: users.filter((u) => !u.emailVerifiedAt && !u.deactivatedAt).length,
    failedEmails: t.notifications.where(
      (n) => n.status === 'failed' && ms(n.createdAt) > now - 7 * 86_400_000,
    ).length,
    schedules: listSchedules(ctx),
    weeks,
    unconfirmedSoon,
    recentActivity: listActivity(ctx, 8),
  };
}

function toEntry(ctx: Ctx, n: NotificationRow): NotificationEntry {
  return {
    id: n.id,
    kind: n.kind,
    toEmail: n.toEmail,
    userName: tables(ctx.db).users.get(n.userId)?.name ?? null,
    subject: n.subject,
    status: n.status,
    attempts: n.attempts,
    lastError: n.lastError,
    sentAt: n.sentAt,
    createdAt: n.createdAt,
  };
}

export function listNotifications(
  ctx: Ctx,
  limit: number,
  status?: NotificationRow['status'],
): NotificationEntry[] {
  return tables(ctx.db)
    .notifications.where((n) => !status || n.status === status)
    .sort((a, b) => ms(b.createdAt) - ms(a.createdAt))
    .slice(0, limit)
    .map((n) => toEntry(ctx, n));
}

/** One email, with its HTML to preview (not for emails with sign-in links). */
export function getNotification(ctx: Ctx, id: string): NotificationEntry & { html: string | null } {
  const n = tables(ctx.db).notifications.get(id);
  if (!n) throw notFound('Email');
  const hidden = (SENSITIVE_KINDS as readonly string[]).includes(n.kind);
  return { ...toEntry(ctx, n), html: hidden ? null : n.html || `<pre>${escapeHtml(n.text)}</pre>` };
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function retryNotification(ctx: Ctx, id: string): void {
  const t = tables(ctx.db);
  const n = t.notifications.get(id);
  if (!n || n.status !== 'failed') throw badRequest('Only failed emails can be retried');
  t.notifications.update(id, { status: 'queued', attempts: 0, runAfter: ctx.now, lastError: null });
  ctx.queued++;
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function updateSettings(
  ctx: Ctx,
  body: Partial<OrgSettings> & { allowedDomains?: string[] },
): OrgSettings {
  const t = tables(ctx.db);
  const domains = body.allowedDomains?.filter(Boolean);
  const invalid = domains?.find((d) => !DOMAIN.test(d));
  if (invalid) {
    throw badRequest(`"${invalid}" is not a valid domain`, { allowedDomains: 'Invalid domain' });
  }
  const patch: Partial<OrgSettingsRow> = {};
  for (const key of [
    'orgName',
    'timezone',
    'weekStartsOn',
    'reminderHours',
    'selfSignup',
    'holidayRegion',
    'timeFormat',
    'emailRetentionDays',
    'overtimeDailyHours',
    'overtimeWeeklyHours',
  ] as const) {
    if (body[key] !== undefined) (patch as Record<string, unknown>)[key] = body[key];
  }
  if (domains) patch.allowedDomains = [...new Set(domains)];
  if (t.settings.get(ORG_ID)) t.settings.update(ORG_ID, patch);
  else t.settings.insert({ id: ORG_ID, ...DEFAULT_SETTINGS, ...patch });
  audit(ctx, ctx.user!.id, 'settings.updated', { type: 'org' }, body);
  return getSettings(ctx.db);
}
