import type { TimeFormat } from '@shared/types';
import type { NotificationKind } from '../../../server/src/email/outbox';
import type { EmailContext, RenderedEmail } from '../../../server/src/email/templates';
import { getSettings, tables, timeFormatFor, zoneFor, type Ctx } from '../core';
import { MAX_CELL } from '../db/store';

export type { NotificationKind };

export function emailContext(ctx: Ctx): EmailContext {
  return { orgName: getSettings(ctx.db).orgName, appUrl: ctx.appUrl };
}

/** Queue an email in the email log; it's sent right after the request (or by the timer). */
export function enqueueEmail(
  ctx: Ctx,
  input: {
    userId: string | null;
    to: string;
    kind: NotificationKind;
    email: RenderedEmail;
    scheduleId?: string | null;
    shiftIds?: string[];
  },
): string {
  // A Sheet cell holds 50,000 characters: a longer email goes out as plain text.
  const html = input.email.html.length < MAX_CELL ? input.email.html : '';
  const text =
    input.email.text.length < MAX_CELL
      ? input.email.text
      : `${input.email.text.slice(0, MAX_CELL - 100)}\n…`;
  const row = tables(ctx.db).notifications.insert({
    userId: input.userId,
    kind: input.kind,
    toEmail: input.to,
    subject: input.email.subject,
    html,
    text,
    scheduleId: input.scheduleId ?? null,
    shiftIds: input.shiftIds ?? [],
    runAfter: ctx.now,
  });
  ctx.queued++;
  return row.id;
}

/** What an admin can choose to be emailed about (see Profile). */
export type AdminTopic = 'time_off' | 'confirmations' | 'swaps';

const WANTS = {
  time_off: 'notifyTimeOff',
  confirmations: 'notifyConfirmations',
  swaps: 'notifySwaps',
} as const;

/**
 * Email every active admin who wants to hear about `topic`, except the person
 * who did the thing. Returns how many emails were queued.
 */
export function notifyAdmins(
  ctx: Ctx,
  input: {
    topic: AdminTopic;
    exceptUserId: string;
    kind: NotificationKind;
    shiftIds?: string[];
    render: (
      email: EmailContext,
      admin: { name: string; tz: string; timeFormat: TimeFormat },
    ) => RenderedEmail;
  },
): number {
  const settings = getSettings(ctx.db);
  const admins = tables(ctx.db).users.where(
    (u) =>
      u.role === 'admin' &&
      !u.deactivatedAt &&
      u.emailVerifiedAt !== null &&
      u.id !== input.exceptUserId &&
      u[WANTS[input.topic]],
  );
  for (const admin of admins) {
    enqueueEmail(ctx, {
      userId: admin.id,
      to: admin.email,
      kind: input.kind,
      shiftIds: input.shiftIds,
      email: input.render(emailContext(ctx), {
        name: admin.name,
        tz: zoneFor(admin, settings),
        timeFormat: timeFormatFor(admin, settings),
      }),
    });
  }
  return admins.length;
}

/** Someone to email, with their own time zone and 12/24-hour choice. */
export interface Reader {
  id: string;
  email: string;
  active: boolean;
  timezone: string | null;
  timeFormat: TimeFormat | null;
}

export function reader(u: {
  id: string;
  email: string;
  deactivatedAt: string | null;
  timezone: string | null;
  timeFormat: TimeFormat | null;
}): Reader {
  return {
    id: u.id,
    email: u.email,
    active: !u.deactivatedAt,
    timezone: u.timezone,
    timeFormat: u.timeFormat,
  };
}

/** Email one person in their own zone and format (nobody, if they're deactivated). */
export function notifyPerson(
  ctx: Ctx,
  person: Reader,
  input: {
    kind: NotificationKind;
    shiftIds?: string[];
    render: (email: EmailContext, prefs: { tz: string; timeFormat: TimeFormat }) => RenderedEmail;
  },
): void {
  if (!person.active) return;
  const settings = getSettings(ctx.db);
  enqueueEmail(ctx, {
    userId: person.id,
    to: person.email,
    kind: input.kind,
    shiftIds: input.shiftIds,
    email: input.render(emailContext(ctx), {
      tz: zoneFor(person, settings),
      timeFormat: timeFormatFor(person, settings),
    }),
  });
}
