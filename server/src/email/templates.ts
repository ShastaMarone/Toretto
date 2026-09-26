import {
  diffDays,
  formatDateRange,
  formatDay,
  formatShiftWhen,
  localDate,
  tzAbbreviation,
  type TimeFormat,
} from '@shared/time';
import { html, safeColor, type SafeHtml } from './html';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface EmailContext {
  orgName: string;
  appUrl: string;
}

export interface EmailShift {
  id: string;
  startTime: string;
  endTime: string;
  labelName: string | null;
  /** Accent color: the label's, else the person's tier's. */
  color: string | null;
  notes: string | null;
  /** Include a "Confirm this shift" link. */
  needsConfirmation: boolean;
}

const BRAND = '#9333ea';
const FONT = '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif';

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function layout(
  ctx: EmailContext,
  opts: { title: string; preheader: string; body: SafeHtml; footer?: string },
): string {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <title>${opts.title}</title>
      </head>
      <body style="margin:0;padding:0;background-color:#f1f5f9;">
        <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
          ${opts.preheader}
        </div>
        <table
          role="presentation"
          width="100%"
          cellpadding="0"
          cellspacing="0"
          border="0"
          style="background-color:#f1f5f9;"
        >
          <tr>
            <td align="center" style="padding:24px 12px;">
              <table
                role="presentation"
                width="100%"
                cellpadding="0"
                cellspacing="0"
                border="0"
                style="max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;border-radius:12px;"
              >
                <tr>
                  <td
                    style="padding:18px 28px;border-bottom:1px solid #e2e8f0;font-family:${FONT};font-size:15px;font-weight:700;color:#0f172a;"
                  >
                    <span
                      style="display:inline-block;width:10px;height:10px;border-radius:3px;background-color:${BRAND};margin-right:8px;"
                    ></span
                    >${ctx.orgName}
                  </td>
                </tr>
                <tr>
                  <td
                    style="padding:28px;font-family:${FONT};font-size:15px;line-height:1.6;color:#0f172a;"
                  >
                    ${opts.body}
                  </td>
                </tr>
              </table>
              <p
                style="max-width:600px;margin:16px auto 0;font-family:${FONT};font-size:12px;line-height:1.5;color:#64748b;"
              >
                ${opts.footer ?? `Sent by ${ctx.orgName} scheduling.`}
              </p>
            </td>
          </tr>
        </table>
      </body>
    </html>`.value;
}

const heading = (text: string) =>
  html`<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#0f172a;">${text}</h1>`;
const para = (content: unknown) => html`<p style="margin:0 0 14px;">${content}</p>`;
const muted = (content: unknown) =>
  html`<p style="margin:14px 0 0;font-size:13px;line-height:1.5;color:#64748b;">${content}</p>`;
const sectionTitle = (text: string) =>
  html`<h2
    style="margin:22px 0 10px;font-size:13px;letter-spacing:0.04em;text-transform:uppercase;color:#475569;"
  >
    ${text}
  </h2>`;

function button(href: string, label: string): SafeHtml {
  return html`<table
    role="presentation"
    cellpadding="0"
    cellspacing="0"
    border="0"
    style="margin:22px 0 8px;"
  >
    <tr>
      <td style="border-radius:8px;background-color:${BRAND};">
        <a
          href="${href}"
          target="_blank"
          style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;"
          >${label}</a
        >
      </td>
    </tr>
  </table>`;
}

const link = (href: string, label: string) =>
  html`<a
    href="${href}"
    target="_blank"
    style="color:${BRAND};font-weight:600;text-decoration:none;"
    >${label}</a
  >`;

function shiftMeta(shift: EmailShift): string {
  return shift.labelName ?? '';
}

function shiftCard(
  ctx: EmailContext,
  shift: EmailShift,
  tz: string,
  format: TimeFormat,
  opts: { cancelled?: boolean; before?: EmailShift } = {},
): SafeHtml {
  const accent = opts.cancelled ? '#cbd5e1' : safeColor(shift.color ?? BRAND);
  const titleStyle = opts.cancelled
    ? 'font-size:15px;font-weight:600;color:#94a3b8;text-decoration:line-through;'
    : 'font-size:15px;font-weight:600;color:#0f172a;';
  const before = opts.before;
  return html`<table
    role="presentation"
    width="100%"
    cellpadding="0"
    cellspacing="0"
    border="0"
    style="margin:0 0 10px;border:1px solid #e2e8f0;border-left:4px solid ${accent};border-radius:8px;"
  >
    <tr>
      <td style="padding:12px 14px;font-family:${FONT};">
        ${before ? html`<div style="font-size:13px;color:#94a3b8;text-decoration:line-through;">Was: ${formatShiftWhen(before.startTime, before.endTime, tz, format)}${before.labelName !== shift.labelName && before.labelName ? ` · ${before.labelName}` : ''}</div>` : ''}
        <div style="${titleStyle}">${formatShiftWhen(shift.startTime, shift.endTime, tz, format)}</div>
        ${shiftMeta(shift) ? html`<div style="font-size:13px;color:#475569;">${shiftMeta(shift)}</div>` : ''}
        ${shift.notes ? html`<div style="font-size:13px;color:#64748b;margin-top:4px;">Note: ${shift.notes}</div>` : ''}
        ${shift.needsConfirmation && !opts.cancelled ? html`<div style="margin-top:8px;font-size:14px;">${link(`${ctx.appUrl}/confirm-shift/${shift.id}`, 'Confirm this shift →')}</div>` : ''}
      </td>
    </tr>
  </table>`;
}

function shiftText(
  ctx: EmailContext,
  shift: EmailShift,
  tz: string,
  format: TimeFormat,
  prefix = '-',
): string {
  const meta = shiftMeta(shift);
  const lines = [
    `${prefix} ${formatShiftWhen(shift.startTime, shift.endTime, tz, format)}${meta ? ` (${meta})` : ''}`,
  ];
  if (shift.notes) lines.push(`  Note: ${shift.notes}`);
  if (shift.needsConfirmation) lines.push(`  Confirm: ${ctx.appUrl}/confirm-shift/${shift.id}`);
  return lines.join('\n');
}

function tzNote(tz: string, atIso?: string): string {
  return `Times are shown in ${tzAbbreviation(tz, atIso)} (${tz.replace(/_/g, ' ')}).`;
}

const plural = (n: number, word: string, pluralWord = `${word}s`) =>
  `${n} ${n === 1 ? word : pluralWord}`;

/** Greet people by first name: "Hi Priya,". */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function dayCount(startDate: string, endDate: string): string {
  return plural(diffDays(startDate, endDate) + 1, 'day');
}

function oneLine(subject: string): string {
  return subject.replace(/[\r\n]+/g, ' ').trim();
}

function finish(subject: string, htmlBody: string, text: string): RenderedEmail {
  return { subject: oneLine(subject), html: htmlBody, text: text.trim() + '\n' };
}

// ---------------------------------------------------------------------------
// Account emails
// ---------------------------------------------------------------------------

export function verifyEmailTemplate(
  ctx: EmailContext,
  input: { name: string; url: string },
): RenderedEmail {
  const subject = `Confirm your email for ${ctx.orgName}`;
  const body = html`${heading('Confirm your email')}
${para(`Hi ${firstName(input.name)}, confirm your email address and choose a password to finish setting up your ${ctx.orgName} scheduling account.`)}
${button(input.url, 'Confirm email & choose password')}
${muted("This link expires in 48 hours. If you didn't create an account, you can ignore this email — nothing happens until the link is used.")}`;
  const text = `Hi ${firstName(input.name)},

Confirm your email address and choose a password to finish setting up your ${ctx.orgName} scheduling account:
${input.url}

This link expires in 48 hours. If you didn't create an account, you can ignore this email.`;
  return finish(
    subject,
    layout(ctx, { title: subject, preheader: 'Confirm your email and choose a password', body }),
    text,
  );
}

export function inviteTemplate(
  ctx: EmailContext,
  input: { name: string; inviterName: string | null; url: string },
): RenderedEmail {
  const who = input.inviterName ?? ctx.orgName;
  const subject = `${who} invited you to the ${ctx.orgName} schedule`;
  const body = html`${heading(`You're invited to ${ctx.orgName}`)}
  ${para(`Hi ${firstName(input.name)}, ${who} added you to the ${ctx.orgName} team schedule. Accept your invite to set a password — then you can see and confirm your shifts and request time off.`)}
  ${button(input.url, 'Accept invite')}
  ${muted('This link expires in 7 days. Your email address is confirmed when you accept.')}`;
  const text = `Hi ${firstName(input.name)},

${who} added you to the ${ctx.orgName} team schedule. Accept your invite to set a password — then you can see and confirm your shifts and request time off:
${input.url}

This link expires in 7 days.`;
  return finish(
    subject,
    layout(ctx, { title: subject, preheader: 'Set your password to see your shifts', body }),
    text,
  );
}

export function resetPasswordTemplate(
  ctx: EmailContext,
  input: { name: string; url: string },
): RenderedEmail {
  const subject = `Reset your ${ctx.orgName} password`;
  const body = html`${heading('Reset your password')}
  ${para(`Hi ${firstName(input.name)}, use the button below to choose a new password.`)}
  ${button(input.url, 'Choose a new password')}
  ${muted("This link expires in 1 hour. If you didn't ask to reset your password, you can ignore this email.")}`;
  const text = `Hi ${firstName(input.name)},

Choose a new password here:
${input.url}

This link expires in 1 hour. If you didn't ask to reset your password, you can ignore this email.`;
  return finish(
    subject,
    layout(ctx, { title: subject, preheader: 'Choose a new password', body }),
    text,
  );
}

export function magicLinkTemplate(
  ctx: EmailContext,
  input: { name: string; url: string },
): RenderedEmail {
  const subject = `Your sign-in link for ${ctx.orgName}`;
  const body = html`${heading('Sign in to your schedule')}
  ${para(`Hi ${firstName(input.name)}, here's your sign-in link.`)} ${button(input.url, 'Sign in')}
  ${muted("This link works once and expires in 20 minutes. If you didn't ask for it, you can ignore this email.")}`;
  const text = `Hi ${firstName(input.name)},

Sign in to ${ctx.orgName} scheduling:
${input.url}

This link works once and expires in 20 minutes.`;
  return finish(
    subject,
    layout(ctx, { title: subject, preheader: 'Your one-time sign-in link', body }),
    text,
  );
}

export function accountExistsTemplate(
  ctx: EmailContext,
  input: { name: string; signInUrl: string; resetUrl: string },
): RenderedEmail {
  const subject = `You already have a ${ctx.orgName} account`;
  const body = html`${heading('You already have an account')}
  ${para(`Hi ${firstName(input.name)}, someone (hopefully you) tried to sign up with this email address, but you already have an account.`)}
  ${button(input.signInUrl, 'Sign in')}
  ${muted(html`Forgot your password? ${link(input.resetUrl, 'Reset it here')}.`)}`;
  const text = `Hi ${firstName(input.name)},

Someone (hopefully you) tried to sign up with this email address, but you already have an account.
Sign in: ${input.signInUrl}
Forgot your password? ${input.resetUrl}`;
  return finish(subject, layout(ctx, { title: subject, preheader: 'Sign in instead', body }), text);
}

// ---------------------------------------------------------------------------
// Schedule emails
// ---------------------------------------------------------------------------

export interface ScheduleEmailInput {
  recipientName: string;
  tz: string;
  timeFormat: TimeFormat;
  /** Named only when the organization has more than one schedule. */
  scheduleName: string | null;
  /** First and last day of this person's changes. */
  startDate: string;
  endDate: string;
  added: EmailShift[];
  updated: { before: EmailShift; after: EmailShift }[];
  removed: EmailShift[];
}

/** Link that confirms the given shifts (after signing in, with a button press). */
export function confirmShiftsUrl(ctx: EmailContext, shiftIds: string[]): string {
  return `${ctx.appUrl}/confirm-shifts?ids=${shiftIds.join(',')}`;
}

export function scheduleTemplate(ctx: EmailContext, input: ScheduleEmailInput): RenderedEmail {
  const { tz, timeFormat: format, added, updated, removed } = input;
  const range =
    input.startDate === input.endDate
      ? formatDay(input.startDate)
      : formatDateRange(input.startDate, input.endDate);
  const on = input.scheduleName ? ` on the ${input.scheduleName}` : '';
  const toConfirm = [...added, ...updated.map((u) => u.after)].filter((s) => s.needsConfirmation);
  const onlyRemoved = added.length === 0 && updated.length === 0;
  const onlyAdded = updated.length === 0 && removed.length === 0;
  const firstAt = added[0]?.startTime ?? updated[0]?.after.startTime ?? removed[0]?.startTime;
  const hi = `Hi ${firstName(input.recipientName)},`;

  let subject: string;
  let intro: string;
  let title: string;
  if (onlyRemoved) {
    subject = `${removed.length === 1 ? 'Shift' : 'Shifts'} cancelled: ${range}`;
    title = removed.length === 1 ? 'Shift cancelled' : 'Shifts cancelled';
    intro = `${hi} ${removed.length === 1 ? 'one of your shifts has' : `${removed.length} of your shifts have`} been cancelled${on} (${range}).`;
  } else if (onlyAdded) {
    subject = `Your schedule for ${range}`;
    title = 'Your schedule is ready';
    intro = `${hi} you have ${plural(added.length, 'new shift')}${on} for ${range}${toConfirm.length ? ' — please confirm them' : ''}.`;
  } else {
    subject = `Schedule updated: ${range}`;
    title = 'Your schedule changed';
    intro = `${hi} your shifts${on} for ${range} have changed.`;
  }

  const confirmUrl = confirmShiftsUrl(
    ctx,
    toConfirm.map((s) => s.id),
  );
  const cta = toConfirm.length
    ? button(
        confirmUrl,
        toConfirm.length === 1 ? 'Confirm my shift' : `Confirm all ${toConfirm.length} shifts`,
      )
    : button(`${ctx.appUrl}/my-schedule`, 'View my schedule');

  const body = html`${heading(title)}
  ${para(intro)}
  ${added.length ? html`${onlyAdded ? '' : sectionTitle('New shifts')}${added.map((s) => shiftCard(ctx, s, tz, format))}` : ''}
  ${updated.length ? html`${sectionTitle('Changed shifts')}${updated.map((u) => shiftCard(ctx, u.after, tz, format, { before: u.before }))}` : ''}
  ${removed.length ? html`${onlyRemoved ? '' : sectionTitle('Cancelled shifts')}${removed.map((s) => shiftCard(ctx, s, tz, format, { cancelled: true }))}` : ''}
  ${cta}
  ${toConfirm.length ? muted(html`Or ${link(`${ctx.appUrl}/my-schedule`, 'open your schedule')} to review everything first.`) : ''}
  ${muted(tzNote(tz, firstAt))}`;

  const textParts = [intro, ''];
  if (added.length) {
    if (!onlyAdded) textParts.push('NEW SHIFTS');
    textParts.push(...added.map((s) => shiftText(ctx, s, tz, format)), '');
  }
  if (updated.length) {
    textParts.push('CHANGED SHIFTS');
    for (const u of updated) {
      textParts.push(`- Was: ${formatShiftWhen(u.before.startTime, u.before.endTime, tz, format)}`);
      textParts.push(shiftText(ctx, u.after, tz, format, '  Now:'));
    }
    textParts.push('');
  }
  if (removed.length) {
    if (!onlyRemoved) textParts.push('CANCELLED SHIFTS');
    textParts.push(
      ...removed.map((s) => shiftText(ctx, { ...s, needsConfirmation: false }, tz, format)),
      '',
    );
  }
  if (toConfirm.length > 1) textParts.push(`Confirm all: ${confirmUrl}`);
  textParts.push(`My schedule: ${ctx.appUrl}/my-schedule`, '', tzNote(tz, firstAt));

  return finish(
    subject,
    layout(ctx, {
      title: subject,
      preheader: intro,
      body,
      footer: `You're receiving this because you're on the ${ctx.orgName} schedule.`,
    }),
    textParts.join('\n'),
  );
}

/** Tells an admin that someone confirmed their shifts. */
export function shiftsConfirmedTemplate(
  ctx: EmailContext,
  input: {
    recipientName: string;
    personName: string;
    tz: string;
    timeFormat: TimeFormat;
    shifts: EmailShift[];
  },
): RenderedEmail {
  const { shifts, tz, timeFormat: format } = input;
  const first = shifts[0]!;
  const subject =
    shifts.length === 1
      ? `${input.personName} confirmed their shift on ${formatDay(localDate(first.startTime, tz))}`
      : `${input.personName} confirmed ${shifts.length} shifts`;
  const summary = `${input.personName} confirmed ${shifts.length === 1 ? 'this shift' : `these ${shifts.length} shifts`}:`;
  const url = `${ctx.appUrl}/admin`;
  const listed = shifts.map((s) => ({ ...s, needsConfirmation: false }));
  const body = html`${heading(shifts.length === 1 ? 'Shift confirmed' : 'Shifts confirmed')}
  ${para(`Hi ${firstName(input.recipientName)}, ${summary}`)}
  ${listed.map((s) => shiftCard(ctx, s, tz, format))} ${button(url, 'Open dashboard')}
  ${muted(html`${tzNote(tz, first.startTime)} You can turn these emails off in ${link(`${ctx.appUrl}/profile`, 'your profile')}.`)}`;
  const text = [
    `Hi ${firstName(input.recipientName)},`,
    '',
    summary,
    ...listed.map((s) => shiftText(ctx, s, tz, format)),
    '',
    `Dashboard: ${url}`,
    '',
    tzNote(tz, first.startTime),
    `Turn these emails off: ${ctx.appUrl}/profile`,
  ].join('\n');
  return finish(subject, layout(ctx, { title: subject, preheader: summary, body }), text);
}

export function reminderTemplate(
  ctx: EmailContext,
  input: { recipientName: string; tz: string; timeFormat: TimeFormat; shifts: EmailShift[] },
): RenderedEmail {
  const { shifts, tz, timeFormat: format } = input;
  const first = shifts[0]!;
  const subject =
    shifts.length === 1
      ? `Reminder: please confirm your shift on ${formatDay(localDate(first.startTime, tz))}`
      : `Reminder: please confirm your ${shifts.length} upcoming shifts`;
  const intro = `Hi ${firstName(input.recipientName)}, ${shifts.length === 1 ? 'this shift is' : 'these shifts are'} still waiting for your confirmation:`;
  const body = html`${heading('Please confirm your shifts')} ${para(intro)}
  ${shifts.map((s) => shiftCard(ctx, { ...s, needsConfirmation: true }, tz, format))}
  ${button(`${ctx.appUrl}/my-schedule`, 'Review my shifts')} ${muted(tzNote(tz, first.startTime))}`;
  const text = [
    intro,
    '',
    ...shifts.map((s) => shiftText(ctx, { ...s, needsConfirmation: true }, tz, format)),
    '',
    `My schedule: ${ctx.appUrl}/my-schedule`,
    '',
    tzNote(tz, first.startTime),
  ].join('\n');
  return finish(subject, layout(ctx, { title: subject, preheader: intro, body }), text);
}

// ---------------------------------------------------------------------------
// Time-off emails
// ---------------------------------------------------------------------------

export function timeOffRequestedTemplate(
  ctx: EmailContext,
  input: {
    recipientName: string;
    requesterName: string;
    typeName: string;
    startDate: string;
    endDate: string;
    note: string | null;
    conflicts: number;
  },
): RenderedEmail {
  const range = formatDateRange(input.startDate, input.endDate);
  const subject = `Time-off request: ${input.requesterName} · ${input.typeName}, ${range}`;
  const summary = `${input.requesterName} requested ${input.typeName} for ${range} (${dayCount(input.startDate, input.endDate)}).`;
  const conflictText = input.conflicts
    ? `They're scheduled for ${plural(input.conflicts, 'shift')} during this time.`
    : null;
  const url = `${ctx.appUrl}/admin/time-off`;
  const body = html`${heading('New time-off request')}
  ${para(`Hi ${firstName(input.recipientName)}, ${summary}`)}
  ${input.note ? html`<blockquote style="margin:0 0 14px;padding:10px 14px;border-left:3px solid #cbd5e1;background-color:#f8fafc;color:#334155;">${input.note}</blockquote>` : ''}
  ${conflictText ? html`<p style="margin:0 0 14px;padding:10px 14px;border-radius:8px;background-color:#fef3c7;color:#92400e;font-size:14px;">${conflictText}</p>` : ''}
  ${button(url, 'Review request')}`;
  const text = [
    `Hi ${firstName(input.recipientName)},`,
    '',
    summary,
    input.note ? `Note: ${input.note}` : '',
    conflictText ?? '',
    '',
    `Review: ${url}`,
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n');
  return finish(subject, layout(ctx, { title: subject, preheader: summary, body }), text);
}

export function timeOffReviewedTemplate(
  ctx: EmailContext,
  input: {
    recipientName: string;
    status: 'approved' | 'denied';
    typeName: string;
    startDate: string;
    endDate: string;
    reviewerName: string | null;
    reviewNote: string | null;
    /** An admin added this time off directly (rather than approving a request). */
    addedByAdmin?: boolean;
  },
): RenderedEmail {
  const range = formatDateRange(input.startDate, input.endDate);
  const approved = input.status === 'approved';
  const subject = input.addedByAdmin
    ? `Time off added: ${input.typeName}, ${range}`
    : `Your time off was ${approved ? 'approved' : 'declined'}: ${input.typeName}, ${range}`;
  const by = input.reviewerName ? ` by ${input.reviewerName}` : '';
  const summary = input.addedByAdmin
    ? `${input.typeName} for ${range} (${dayCount(input.startDate, input.endDate)}) was added to your schedule${by}.`
    : `Your ${input.typeName} request for ${range} (${dayCount(input.startDate, input.endDate)}) was ${approved ? 'approved' : 'declined'}${by}.`;
  const url = `${ctx.appUrl}/my-schedule`;
  const body = html`${heading(input.addedByAdmin ? 'Time off added' : approved ? 'Time off approved' : 'Time off declined')}
  ${para(`Hi ${firstName(input.recipientName)}, ${summary}`)}
  ${input.reviewNote ? html`<blockquote style="margin:0 0 14px;padding:10px 14px;border-left:3px solid #cbd5e1;background-color:#f8fafc;color:#334155;">${input.reviewNote}</blockquote>` : ''}
  ${button(url, 'View my schedule')}`;
  const text = [
    `Hi ${firstName(input.recipientName)},`,
    '',
    summary,
    input.reviewNote ? `Note: ${input.reviewNote}` : '',
    '',
    `My schedule: ${url}`,
  ].join('\n');
  return finish(subject, layout(ctx, { title: subject, preheader: summary, body }), text);
}

export function timeOffCancelledTemplate(
  ctx: EmailContext,
  input: {
    recipientName: string;
    requesterName: string;
    typeName: string;
    startDate: string;
    endDate: string;
  },
): RenderedEmail {
  const range = formatDateRange(input.startDate, input.endDate);
  const subject = `Time off cancelled: ${input.requesterName} · ${input.typeName}, ${range}`;
  const summary = `${input.requesterName} cancelled their approved ${input.typeName} for ${range}. They're available to be scheduled again.`;
  const url = `${ctx.appUrl}/admin/time-off`;
  const body = html`${heading('Time off cancelled')}
  ${para(`Hi ${firstName(input.recipientName)}, ${summary}`)} ${button(url, 'Open time off')}`;
  const text = `Hi ${firstName(input.recipientName)},\n\n${summary}\n\n${url}`;
  return finish(subject, layout(ctx, { title: subject, preheader: summary, body }), text);
}
