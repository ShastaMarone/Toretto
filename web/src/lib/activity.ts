import { formatDateRange, formatShiftWhen } from '@shared/time';
import type { AuditEntry } from '@shared/types';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' ? v : 0);

function range(d: Record<string, unknown>): string {
  return d.startDate && d.endDate ? formatDateRange(str(d.startDate), str(d.endDate)) : '';
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Human-readable description of an audit entry (without the actor's name). */
export function describeActivity(entry: AuditEntry, tz: string): string {
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
      return `${d.firstPublish ? 'published' : 'published changes to'} ${str(d.title)} — ${what}, ${plural(num(d.emails), 'email')} sent`;
    }
    case 'schedule.updated':
      return `edited the details of ${str(d.title)}`;
    case 'schedule.deleted':
      return `deleted ${str(d.title)}${num(d.notified) ? ` and notified ${plural(num(d.notified), 'person')}` : ''}`;
    case 'schedule.changes_discarded':
      return `discarded ${plural(num(d.discarded), 'unpublished change')} on ${str(d.title)}`;
    case 'shift.confirmed':
      return `confirmed their ${str(d.tierName)} shift ${d.startTime ? formatShiftWhen(str(d.startTime), str(d.endTime), tz) : ''}`;
    case 'shift.confirmed_all':
      return `confirmed ${plural(num(d.count), 'shift')}`;
    case 'time_off.requested':
      return `requested ${str(d.typeName)}, ${range(d)}`;
    case 'time_off.approved':
      return `approved ${str(d.personName)}'s ${str(d.typeName)}, ${range(d)}`;
    case 'time_off.denied':
      return `declined ${str(d.personName)}'s ${str(d.typeName)}, ${range(d)}`;
    case 'time_off.cancelled':
      return `cancelled their ${str(d.typeName)}, ${range(d)}`;
    case 'time_off.added':
      return `added ${str(d.typeName)} for ${str(d.personName)}, ${range(d)}`;
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
