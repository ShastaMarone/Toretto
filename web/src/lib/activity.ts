import { addDays, diffDays, formatDateRange, formatShiftWhen, type TimeFormat } from '@shared/time';
import type { AuditEntry } from '@shared/types';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' ? v : 0);

/** Time off's days, or its hours for part of a day. */
function range(d: Record<string, unknown>, tz: string, format: TimeFormat): string {
  if (d.startTime && d.endTime)
    return formatShiftWhen(str(d.startTime), str(d.endTime), tz, format);
  return d.startDate && d.endDate ? formatDateRange(str(d.startDate), str(d.endDate)) : '';
}

/** "Mon, Oct 5 · 9:00 AM – 5:00 PM" from startTime/endTime details. */
function shiftWhen(d: Record<string, unknown>, tz: string, format: TimeFormat): string {
  return d.startTime && d.endTime
    ? formatShiftWhen(str(d.startTime), str(d.endTime), tz, format)
    : '';
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Human-readable description of an audit entry (without the actor's name). */
export function describeActivity(
  entry: AuditEntry,
  tz: string,
  format: TimeFormat = '12h',
): string {
  const d = entry.details;
  switch (entry.action) {
    case 'org.setup':
      return `set up ${str(d.orgName) || 'the organization'}`;
    case 'schedule.created':
      return `created ${str(d.title)}${num(d.copied) ? ` (copied ${plural(num(d.copied), 'shift')})` : ''}`;
    case 'schedule.published': {
      const parts = [
        num(d.added) && `${num(d.added)} new`,
        num(d.updated) && `${num(d.updated)} changed`,
        num(d.removed) && `${num(d.removed)} removed`,
      ].filter(Boolean);
      const what = parts.length ? parts.join(', ') : 'no changes';
      const emails = `${plural(num(d.emails), 'email')} sent`;
      // Older entries (fixed-length schedules) have no range.
      if (!d.range)
        return `${d.firstPublish ? 'published' : 'published changes to'} ${str(d.title)} — ${what}, ${emails}`;
      const where =
        d.range === 'all dates'
          ? `every change on ${str(d.title)}`
          : `${str(d.range)} on ${str(d.title)}`;
      return `published ${where} — ${what}, ${emails}`;
    }
    case 'schedule.updated':
      return `edited the details of ${str(d.title)}`;
    case 'schedule.renamed':
      return `renamed ${str(d.previous) || 'a schedule'} to ${str(d.title)}`;
    case 'schedule.copied': {
      const from = str(d.from);
      const to = str(d.to);
      const target = str(d.targetStart);
      const into =
        from && to && target
          ? ` into ${formatDateRange(target, addDays(target, diffDays(from, to)))}`
          : '';
      return `copied ${plural(num(d.copied), 'shift')} on ${str(d.title)}${from && to ? ` from ${formatDateRange(from, to)}` : ''}${into}`;
    }
    case 'schedule.deleted':
      return `deleted ${str(d.title)}${num(d.notified) ? ` and notified ${plural(num(d.notified), 'person')}` : ''}`;
    case 'schedule.changes_discarded':
      return `discarded ${plural(num(d.discarded), 'unpublished change')} on ${str(d.title)}${d.range && d.range !== 'all dates' ? ` (${str(d.range)})` : ''}`;
    case 'shift.confirmed':
      return `confirmed their ${d.tierName ? `${str(d.tierName)} ` : ''}shift ${d.startTime ? formatShiftWhen(str(d.startTime), str(d.endTime), tz, format) : ''}`.trimEnd();
    case 'shift.confirmed_all':
      return `confirmed ${plural(num(d.count), 'shift')}`;
    case 'time_off.requested':
      return `requested ${str(d.typeName)}, ${range(d, tz, format)}`;
    case 'time_off.approved':
      return `approved ${str(d.personName)}'s ${str(d.typeName)}, ${range(d, tz, format)}`;
    case 'time_off.denied':
      return `declined ${str(d.personName)}'s ${str(d.typeName)}, ${range(d, tz, format)}`;
    case 'time_off.cancelled':
      return `cancelled their ${str(d.typeName)}, ${range(d, tz, format)}`;
    case 'time_off.added':
      return `added ${str(d.typeName)} for ${str(d.personName)}, ${range(d, tz, format)}`;
    case 'swap.requested':
      return `offered ${str(d.recipientName)} their shift ${shiftWhen(d, tz, format)}${d.trade ? ' as a trade' : ''}`;
    case 'swap.accepted':
      return `agreed to take ${str(d.requesterName)}'s shift ${shiftWhen(d, tz, format)}`;
    case 'swap.declined':
      return `declined ${str(d.requesterName)}'s swap request`;
    case 'swap.cancelled':
      return `withdrew their swap request to ${str(d.recipientName)}`;
    case 'swap.approved':
      return `approved ${str(d.requesterName)} and ${str(d.recipientName)}'s swap (${shiftWhen(d, tz, format)})`;
    case 'swap.denied':
      return `declined ${str(d.requesterName)} and ${str(d.recipientName)}'s swap`;
    case 'user.invited':
      return `invited ${str(d.name)} (${str(d.email)})`;
    case 'user.invite_resent':
      return `re-sent ${str(d.name)}'s invite`;
    case 'user.invite_accepted':
      return 'accepted their invite and joined';
    case 'user.signed_up':
      return 'signed up';
    case 'user.email_verified':
      return 'confirmed their email address';
    case 'user.password_reset':
      return 'reset their password';
    case 'user.updated':
      return `updated ${str(d.name)}'s details`;
    case 'user.deactivated':
      return `deactivated ${str(d.name)}`;
    case 'user.reactivated':
      return `reactivated ${str(d.name)}`;
    case 'user.deleted':
      return `removed ${str(d.name)}`;
    case 'settings.updated':
      return 'updated organization settings';
    default: {
      const [kind, verb] = entry.action.split('.');
      const noun = (kind ?? '').replace(/_/g, '-');
      return `${verb ?? 'changed'} ${noun}${d.name ? ` “${str(d.name)}”` : ''}`;
    }
  }
}
