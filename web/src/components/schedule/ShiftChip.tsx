import { formatTimeRange, formatTimeRangeCompact } from '@shared/time';
import type { ShiftStatus, TimeOffEntry } from '@shared/types';
import { Check, Clock, Plane, StickyNote, Undo2 } from 'lucide-react';
import type { DragEvent, ReactNode } from 'react';
import { alpha } from '../../lib/colors';
import { cx } from '../../lib/cx';

export function StatusIcon({ status, className }: { status: ShiftStatus; className?: string }) {
  return status === 'confirmed' ? (
    <Check className={cx('size-3.5 text-emerald-600', className)} aria-label="Confirmed" />
  ) : (
    <Clock
      className={cx('size-3.5 text-amber-600', className)}
      aria-label="Waiting for confirmation"
    />
  );
}

export interface ChipShift {
  startTime: string;
  endTime: string;
  notes?: string | null;
}

/**
 * One shift in a grid cell. Pending (unconfirmed) published shifts have a
 * dashed outline; confirmed ones are solid with a check.
 */
export function ShiftChip({
  shift,
  tz,
  color,
  labelName,
  status,
  change,
  removed = false,
  mine = false,
  caption,
  onClick,
  onRestore,
  draggable = false,
  onDragStart,
  onDragEnd,
  dragging = false,
  compact = false,
}: {
  shift: ChipShift;
  tz: string;
  color: string;
  labelName?: string | null;
  /** null = never published (draft). */
  status: ShiftStatus | null;
  change?: 'new' | 'updated' | null;
  removed?: boolean;
  mine?: boolean;
  caption?: ReactNode;
  onClick?: () => void;
  onRestore?: () => void;
  draggable?: boolean;
  onDragStart?: (e: DragEvent<HTMLElement>) => void;
  onDragEnd?: (e: DragEvent<HTMLElement>) => void;
  dragging?: boolean;
  /** Tighter layout for small cells (month view): no icons, collapsed am/pm. */
  compact?: boolean;
}) {
  const time = compact
    ? formatTimeRangeCompact(shift.startTime, shift.endTime, tz)
    : formatTimeRange(shift.startTime, shift.endTime, tz, { short: true });
  const Tag = onClick ? 'button' : 'div';
  const edge = removed ? '#cbd5e1' : alpha(color, status === 'pending' ? 0.8 : 0.35);
  const statusText =
    status === 'confirmed'
      ? 'confirmed'
      : status === 'pending'
        ? 'waiting for confirmation'
        : 'draft';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      title={[time, labelName, shift.notes].filter(Boolean).join(' · ')}
      aria-label={`${time}${labelName ? `, ${labelName}` : ''}, ${removed ? 'will be removed' : statusText}`}
      className={cx(
        'group/chip relative block w-full min-w-0 rounded-md border py-1 text-left text-xs leading-tight transition',
        compact ? 'px-1.5' : 'px-2',
        status === 'pending' && !removed ? 'border-dashed' : 'border-solid',
        removed && 'opacity-60',
        onClick && 'cursor-pointer hover:shadow-sm',
        draggable && 'cursor-grab active:cursor-grabbing',
        dragging && 'opacity-40',
        mine && 'ring-2 ring-indigo-500/40',
      )}
      style={{
        backgroundColor: removed ? '#f8fafc' : alpha(color, 0.1),
        // Longhands only: mixing border shorthands confuses React's style diffing.
        borderTopColor: edge,
        borderRightColor: edge,
        borderBottomColor: edge,
        borderLeftColor: removed ? '#cbd5e1' : color,
        borderLeftWidth: 3,
        borderLeftStyle: 'solid',
      }}
    >
      <span className="flex items-center gap-1">
        <span className={cx('truncate font-semibold text-slate-800', removed && 'line-through')}>
          {time}
        </span>
        {status && !removed && !compact && (
          <StatusIcon status={status} className="ml-auto shrink-0" />
        )}
        {shift.notes && !removed && !compact && (
          <StickyNote className="size-3 shrink-0 text-slate-400" aria-label="Has a note" />
        )}
      </span>
      {(labelName || caption) && (
        <span
          className={cx(
            'mt-0.5 block truncate text-[11px] text-slate-600',
            removed && 'line-through',
          )}
        >
          {labelName}
          {labelName && caption ? ' · ' : ''}
          {caption}
        </span>
      )}
      {change && !removed && (
        <span
          className={cx(
            'absolute -top-1.5 -right-1.5 rounded-full px-1 text-[9px] font-bold uppercase leading-4 text-white shadow-sm',
            change === 'new' ? 'bg-emerald-500' : 'bg-amber-500',
          )}
        >
          {change === 'new' ? 'New' : 'Edit'}
        </span>
      )}
      {removed && onRestore && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onRestore();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onRestore();
            }
          }}
          className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-semibold text-indigo-600 hover:text-indigo-500"
        >
          <Undo2 className="size-3" /> Undo remove
        </span>
      )}
    </Tag>
  );
}

export function TimeOffChip({
  entry,
  compact = false,
}: {
  entry: TimeOffEntry;
  compact?: boolean;
}) {
  const color = entry.typeColor ?? '#64748b';
  const label = entry.typeName ?? 'Time off';
  return (
    <div
      className={cx(
        'stripes flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium leading-tight text-slate-700',
        entry.status === 'pending' ? 'border-dashed' : 'border-solid',
      )}
      style={{ borderColor: alpha(color, 0.6), backgroundColor: alpha(color, 0.08) }}
      title={`${label}${entry.status === 'pending' ? ' (requested)' : ''}`}
    >
      <Plane className="size-3 shrink-0" style={{ color }} aria-hidden />
      <span className="truncate">
        {label}
        {entry.status === 'pending' && !compact && (
          <span className="font-normal text-slate-500"> · requested</span>
        )}
      </span>
    </div>
  );
}

export function ScheduleLegend({ showChanges = false }: { showChanges?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-500">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-4 w-6 rounded border border-dashed border-slate-400 bg-slate-50" />
        <Clock className="size-3.5 text-amber-600" /> Waiting for confirmation
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-4 w-6 rounded border border-slate-300 bg-slate-50" />
        <Check className="size-3.5 text-emerald-600" /> Confirmed
      </span>
      <span className="flex items-center gap-1.5">
        <span className="stripes inline-block h-4 w-6 rounded border border-slate-300" /> Time off
      </span>
      {showChanges && (
        <>
          <span className="flex items-center gap-1.5">
            <span className="rounded-full bg-emerald-500 px-1 text-[9px] font-bold uppercase leading-4 text-white">
              New
            </span>
            Not published yet
          </span>
          <span className="flex items-center gap-1.5">
            <span className="rounded-full bg-amber-500 px-1 text-[9px] font-bold uppercase leading-4 text-white">
              Edit
            </span>
            Changed since publishing
          </span>
        </>
      )}
    </div>
  );
}
