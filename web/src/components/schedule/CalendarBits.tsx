import type { Holiday } from '@shared/holidays';
import { formatDay, type ISODate } from '@shared/time';
import type { Tier } from '@shared/types';
import { CalendarDays, ChevronLeft, ChevronRight, Leaf } from 'lucide-react';
import { DateTime } from 'luxon';
import { useRef, useState, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Button } from '../ui/Button';
import { ColorDot } from '../ui/Misc';
import { Calendar } from '../ui/Pickers';
import { Popover } from '../ui/Popover';

/** "Thanksgiving" pill for a day that's a statutory holiday. */
export function HolidayBadge({
  holidays,
  compact = false,
  wrap = false,
}: {
  holidays: Holiday[];
  /** Icon only. */
  compact?: boolean;
  /** Up to two lines instead of one, for narrow spaces. */
  wrap?: boolean;
}) {
  const names = holidays.map((h) => h.name).join(', ');
  return (
    <span
      title={names}
      className={cx(
        'relative inline-flex min-w-0 max-w-full gap-1 bg-rose-50 py-0.5 text-[10px] leading-tight font-semibold text-rose-700 ring-1 ring-rose-200 ring-inset dark:shadow-[0_0_14px_-5px_rgb(255_107_142/0.7)]',
        compact ? 'px-1' : 'px-1.5',
        wrap ? 'items-start rounded-md text-left' : 'items-center rounded-full',
      )}
    >
      <Leaf className={cx('size-3 shrink-0', wrap && 'mt-px')} aria-hidden />
      {!compact && <span className={wrap ? 'line-clamp-2' : 'truncate'}>{names}</span>}
      <span className="sr-only">Statutory holiday: {names}</span>
    </span>
  );
}

/** Column header for one day: weekday, date, "today", holiday, and a summary line. */
export function DayHeader({
  day,
  today,
  holidays,
  summary,
  compact = false,
}: {
  day: ISODate;
  today: ISODate;
  holidays?: Holiday[];
  summary?: ReactNode;
  compact?: boolean;
}) {
  const dt = DateTime.fromISO(day);
  const isToday = day === today;
  return (
    <th
      scope="col"
      data-today={isToday || undefined}
      aria-label={formatDay(day, 'long')}
      className={cx(
        'px-1 py-2 text-center align-top text-xs font-semibold',
        isToday ? 'text-brand-700' : 'text-slate-500',
        holidays?.length && 'bg-rose-50/50',
      )}
    >
      <span className="block uppercase tracking-wide">
        {dt.toFormat(compact ? 'ccccc' : 'ccc')}
      </span>
      <span
        className={cx(
          'mt-0.5 inline-flex size-7 items-center justify-center rounded-full text-sm tabular-nums',
          isToday ? 'neon bg-neon text-white' : 'text-slate-800',
        )}
      >
        {dt.day}
      </span>
      {holidays?.length ? (
        <span className="mt-1 flex justify-center px-0.5">
          <HolidayBadge holidays={holidays} compact={compact} wrap />
        </span>
      ) : null}
      {summary !== undefined && (
        <span className="mt-0.5 block truncate font-normal text-slate-400">{summary}</span>
      )}
    </th>
  );
}

/** Toggle chips to show only some tiers. An empty selection means every tier. */
export function TierFilter({
  tiers,
  selected,
  onChange,
}: {
  tiers: Pick<Tier, 'id' | 'name' | 'color'>[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const chip =
    'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset transition';
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show tiers">
      <button
        type="button"
        aria-pressed={selected.length === 0}
        onClick={() => onChange([])}
        className={cx(
          chip,
          selected.length === 0
            ? 'neon bg-neon text-white ring-transparent'
            : 'bg-surface/60 text-slate-600 ring-slate-300 hover:text-slate-900',
        )}
      >
        All tiers
      </button>
      {tiers.map((t) => {
        const on = selected.includes(t.id);
        return (
          <button
            key={t.id}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(t.id)}
            className={cx(
              chip,
              on
                ? 'bg-surface text-slate-900 ring-2'
                : 'bg-surface/60 text-slate-600 ring-slate-300 hover:text-slate-900',
            )}
            style={
              on
                ? { boxShadow: `0 0 16px -4px ${t.color}`, ['--tw-ring-color' as string]: t.color }
                : undefined
            }
          >
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: t.color }}
              aria-hidden
            />
            {t.name}
          </button>
        );
      })}
    </div>
  );
}

/** Previous / next, the visible range, "Today", and a date picker. */
export function CalendarNav({
  label,
  onPrev,
  onNext,
  onToday,
  isCurrent,
  value,
  onPick,
}: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  isCurrent: boolean;
  value: ISODate;
  onPick: (date: ISODate) => void;
}) {
  const [picking, setPicking] = useState(false);
  const pickButton = useRef<HTMLButtonElement>(null);
  const stopPicking = (refocus: boolean) => {
    setPicking(false);
    if (refocus) pickButton.current?.focus();
  };
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center rounded-xl bg-surface/70 shadow-sm ring-1 ring-inset ring-slate-300 backdrop-blur dark:ring-slate-200">
        <button
          type="button"
          onClick={onPrev}
          aria-label="Previous"
          className="rounded-l-xl p-2 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          ref={pickButton}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={picking}
          onClick={() => setPicking((p) => !p)}
          className="flex min-w-44 items-center justify-center gap-1.5 self-stretch border-x border-slate-200 px-3 text-sm font-semibold tabular-nums text-slate-800 hover:bg-slate-100/70"
        >
          {label}
          <CalendarDays className="size-4 text-slate-400" aria-hidden />
          <span className="sr-only">, pick a date</span>
        </button>
        {picking && (
          <Popover
            anchor={pickButton}
            role="dialog"
            aria-label="Choose a date"
            onClose={(reason) => stopPicking(reason === 'escape')}
          >
            <Calendar
              value={value}
              onPick={(day) => {
                stopPicking(true);
                onPick(day);
              }}
            />
          </Popover>
        )}
        <button
          type="button"
          onClick={onNext}
          aria-label="Next"
          className="rounded-r-xl p-2 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
      <Button onClick={onToday} disabled={isCurrent}>
        Today
      </Button>
    </div>
  );
}

/** A tier heading row that can collapse the people rows under it. */
export function GroupRows({
  label,
  color,
  count,
  hours,
  colSpan,
  collapsed,
  onToggle,
  children,
}: {
  label: string;
  color: string;
  count: number;
  hours: string;
  colSpan: number;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <tr className="border-b border-slate-200/70 bg-slate-50/50">
        <th colSpan={colSpan} scope="colgroup" className="px-0 py-0 text-left">
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={onToggle}
            className="sticky left-0 flex items-center gap-2 px-4 pt-2.5 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-600 hover:text-slate-900"
          >
            <ChevronRight
              className={cx('size-3.5 transition-transform', !collapsed && 'rotate-90')}
            />
            <ColorDot color={color} />
            {label}
            <span className="font-normal normal-case text-slate-400">
              · {count} {count === 1 ? 'person' : 'people'} · {hours}
            </span>
          </button>
        </th>
      </tr>
      {children}
    </>
  );
}
