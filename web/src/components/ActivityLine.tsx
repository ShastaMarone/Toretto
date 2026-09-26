import { formatRelative, formatTimestamp } from '@shared/time';
import type { AuditEntry } from '@shared/types';
import { describeActivity } from '../lib/activity';
import { useTimeFormat } from '../lib/session';
import { Avatar } from './ui/Misc';

export function ActivityLine({ entry, tz }: { entry: AuditEntry; tz: string }) {
  const timeFormat = useTimeFormat();
  return (
    <li className="flex gap-3 px-5 py-3">
      <Avatar name={entry.actorName ?? 'System'} size="sm" className="mt-0.5" />
      <div className="min-w-0 text-sm">
        <p className="text-slate-700">
          <span className="font-semibold text-slate-900">{entry.actorName ?? 'Someone'}</span>{' '}
          {describeActivity(entry, tz, timeFormat)}
        </p>
        <p
          className="text-xs text-slate-400"
          title={formatTimestamp(entry.createdAt, tz, timeFormat)}
        >
          {formatRelative(entry.createdAt)}
        </p>
      </div>
    </li>
  );
}
