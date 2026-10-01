import type { Holiday } from '@shared/holidays';
import { formatHours, formatTimeOfDay, localDate, localTime, shiftHours } from '@shared/time';
import type { ISODate, TimeFormat } from '@shared/time';
import type { PersonRow, ShiftStatus, TimeOffEntry } from '@shared/types';
import { Plane, Plus, StickyNote, Undo2 } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { alpha } from '../../lib/colors';
import { cx } from '../../lib/cx';
import type { PeopleGroup } from '../../lib/schedule';
import { Card } from '../ui/Misc';
import { HolidayBadge, GroupRows } from './CalendarBits';
import { StatusIcon } from './ShiftChip';

const DAY_MINUTES = 24 * 60;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** One shift on a person's timeline. */
export interface TimelineBar {
  id: string;
  startTime: string;
  endTime: string;
  color: string;
  labelName?: string | null;
  notes?: string | null;
  /** null = never published (draft). */
  status: ShiftStatus | null;
  change?: 'new' | 'updated' | null;
  /** A published shift going away (or moved off this day): shown faded. */
  removed?: boolean;
  caption?: ReactNode;
  draggable?: boolean;
  dragging?: boolean;
  onClick?: () => void;
  onRestore?: () => void;
  onDragStart?: (e: DragEvent<HTMLElement>) => void;
  onDragEnd?: (e: DragEvent<HTMLElement>) => void;
}

/** Minutes after local midnight of `day`, clamped to the day. */
function minutesIn(iso: string, tz: string, day: ISODate): number {
  const d = localDate(iso, tz);
  if (d < day) return 0;
  if (d > day) return DAY_MINUTES;
  const [h = 0, m = 0] = localTime(iso, tz).split(':').map(Number);
  return h * 60 + m;
}

/** "9am", or "09:00" in 24-hour format. */
const hourLabel = (hour: number, format: TimeFormat) =>
  formatTimeOfDay(`${String(hour).padStart(2, '0')}:00`, format, true);

/**
 * One day, hour by hour: people down the side (grouped by tier), a bar for each
 * shift across the hours, and under the last row how many people are working
 * each hour, so thin spots stand out. Opens scrolled to the first shift.
 */
export function DayTimeline({
  day,
  today,
  tz,
  timeFormat,
  holidays,
  groups,
  bars,
  timeOff,
  groupHours,
  renderPerson,
  onAdd,
  trackProps,
  highlight,
  empty,
  footer,
}: {
  day: ISODate;
  today: ISODate;
  tz: string;
  timeFormat: TimeFormat;
  holidays?: Holiday[];
  groups: PeopleGroup[];
  bars: (person: PersonRow) => TimelineBar[];
  timeOff: (person: PersonRow) => TimeOffEntry[];
  groupHours: (group: PeopleGroup) => string;
  renderPerson: (person: PersonRow) => ReactNode;
  /** Add a shift for this person, starting at this hour. */
  onAdd: (person: PersonRow, hour: number) => void;
  /** Extra attributes for a person's timeline (drag and drop, extra classes). */
  trackProps?: (person: PersonRow) => HTMLAttributes<HTMLDivElement>;
  highlight?: (person: PersonRow) => boolean;
  empty?: ReactNode;
  footer?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  const people = groups.flatMap((g) => g.people);
  const live = people.map((p) => ({
    person: p,
    bars: bars(p).filter((b) => !b.removed),
  }));

  // How many people are working in each hour.
  const coverage = HOURS.map(
    (h) =>
      live.filter(({ bars: list }) =>
        list.some(
          (b) =>
            minutesIn(b.startTime, tz, day) < (h + 1) * 60 &&
            Math.max(minutesIn(b.endTime, tz, day), minutesIn(b.startTime, tz, day) + 1) > h * 60,
        ),
      ).length,
  );
  const staffed = coverage.flatMap((n, h) => (n > 0 ? [h] : []));
  const [first, last] = [staffed[0] ?? 24, staffed.at(-1) ?? -1];
  const peak = Math.max(1, ...coverage);
  const totalHours = live.reduce(
    (sum, { bars: list }) => sum + list.reduce((s, b) => s + shiftHours(b.startTime, b.endTime), 0),
    0,
  );

  // Open at the first shift (an hour before it), or at 7am when the day is empty.
  const earliest = Math.min(
    7 * 60,
    ...live.flatMap(({ bars: list }) => list.map((b) => minutesIn(b.startTime, tz, day) - 60)),
  );
  const rangeKey = `${day}:${people.length > 0}`;
  useEffect(() => {
    const el = scroller.current;
    const track = el?.querySelector<HTMLElement>('[data-track]');
    if (!el || !track) return;
    el.scrollLeft = Math.max(0, (earliest / DAY_MINUTES) * track.offsetWidth);
    // Only when the day changes, not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey]);

  const nowMinutes = day === today ? minutesIn(new Date().toISOString(), tz, day) : null;
  const toggle = (key: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const hourGrid = (
    <div
      className="pointer-events-none absolute inset-0 grid"
      style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}
      aria-hidden
    >
      {HOURS.map((h) => (
        <div
          key={h}
          className={cx('border-l border-slate-100', h >= 8 && h < 18 ? '' : 'bg-slate-50/50')}
        />
      ))}
    </div>
  );

  return (
    <Card className="overflow-hidden">
      <div ref={scroller} className="overflow-x-auto scrollbar-thin">
        <table
          className="w-full table-fixed border-collapse text-sm"
          style={{ minWidth: 208 + 24 * 56 }}
        >
          <colgroup>
            <col className="w-44 sm:w-52" />
            <col />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/70">
              <th
                scope="col"
                className="sticky left-0 z-20 bg-slate-50 px-4 py-2.5 text-left align-top text-xs font-semibold text-slate-500"
              >
                {people.length} {people.length === 1 ? 'person' : 'people'}
                {holidays?.length ? (
                  <span className="mt-1 block font-normal">
                    <HolidayBadge holidays={holidays} compact={false} wrap />
                  </span>
                ) : null}
              </th>
              <th scope="col" className="p-0 text-left">
                <div className="grid" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}>
                  {HOURS.map((h) => (
                    <span
                      key={h}
                      className="border-l border-slate-200/70 px-1.5 py-2.5 text-[11px] font-semibold tabular-nums text-slate-500"
                    >
                      {hourLabel(h, timeFormat)}
                    </span>
                  ))}
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const isCollapsed = collapsed.has(group.key);
              return (
                <GroupRows
                  key={group.key}
                  label={group.tier?.name ?? 'No tier'}
                  color={group.tier?.color ?? 'var(--color-slate-400)'}
                  count={group.people.length}
                  hours={groupHours(group)}
                  colSpan={2}
                  collapsed={isCollapsed}
                  onToggle={() => toggle(group.key)}
                >
                  {!isCollapsed &&
                    group.people.map((person) => {
                      const tinted = highlight?.(person) ?? false;
                      const { className: extra, ...props } = trackProps?.(person) ?? {};
                      return (
                        <tr
                          key={person.id}
                          className={cx('border-b border-slate-100', tinted && 'bg-brand-50/40')}
                        >
                          <th
                            scope="row"
                            className={cx(
                              'group sticky left-0 z-20 px-3 py-2 text-left font-normal sm:px-4',
                              tinted ? 'bg-brand-50' : 'bg-surface',
                            )}
                          >
                            <div className="flex items-center justify-between gap-1">
                              <div className="min-w-0">{renderPerson(person)}</div>
                              {person.active && (
                                <button
                                  type="button"
                                  onClick={() => onAdd(person, 9)}
                                  aria-label={`Add shift for ${person.name}`}
                                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-slate-400 opacity-0 transition hover:bg-brand-50 hover:text-brand-600 focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                                >
                                  <Plus className="size-4" />
                                </button>
                              )}
                            </div>
                          </th>
                          <td className="p-0 align-top">
                            <div
                              data-track
                              {...props}
                              onClick={(e) => {
                                // Empty space: a new shift from the hour you clicked.
                                if (!person.active || e.target !== e.currentTarget) return;
                                const box = e.currentTarget.getBoundingClientRect();
                                const hour = Math.floor(((e.clientX - box.left) / box.width) * 24);
                                onAdd(person, Math.min(23, Math.max(0, hour)));
                              }}
                              className={cx(
                                'group/track relative h-[4.5rem] transition-colors',
                                person.active && 'cursor-cell',
                                extra,
                              )}
                            >
                              {hourGrid}
                              {timeOff(person).map((entry) => {
                                const color = entry.typeColor ?? '#8a90b8';
                                const part = entry.startTime && entry.endTime;
                                const start = part ? minutesIn(entry.startTime!, tz, day) : 0;
                                const end = part ? minutesIn(entry.endTime!, tz, day) : DAY_MINUTES;
                                const requested = entry.status === 'pending';
                                return (
                                  <div
                                    key={entry.id}
                                    className={cx(
                                      'stripes pointer-events-none absolute inset-y-1 flex items-center gap-1 overflow-hidden rounded-md border px-2 text-[11px] font-medium text-slate-700',
                                      requested ? 'border-dashed' : 'border-solid',
                                    )}
                                    style={{
                                      left: `${(start / DAY_MINUTES) * 100}%`,
                                      width: `${((end - start) / DAY_MINUTES) * 100}%`,
                                      borderColor: alpha(color, 0.6),
                                      backgroundColor: alpha(color, 0.08),
                                    }}
                                    title={`${entry.typeName ?? 'Time off'}${requested ? ' (requested)' : ''}`}
                                  >
                                    <Plane
                                      className="size-3 shrink-0"
                                      style={{ color }}
                                      aria-hidden
                                    />
                                    <span className="truncate">
                                      {entry.typeName ?? 'Time off'}
                                      {requested && ' · requested'}
                                    </span>
                                  </div>
                                );
                              })}
                              {bars(person).map((bar) => (
                                <Bar key={bar.id} bar={bar} tz={tz} day={day} format={timeFormat} />
                              ))}
                              {nowMinutes !== null && (
                                <div
                                  className="pointer-events-none absolute inset-y-0 z-20 w-px bg-brand-500/70"
                                  style={{ left: `${(nowMinutes / DAY_MINUTES) * 100}%` }}
                                  aria-hidden
                                />
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                </GroupRows>
              );
            })}
            {groups.length === 0 && empty && (
              <tr>
                <td colSpan={2} className="px-4 py-10 text-center text-sm text-slate-500">
                  {empty}
                </td>
              </tr>
            )}
          </tbody>
          {groups.length > 0 && (
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50/70">
                <th
                  scope="row"
                  className="sticky left-0 z-20 bg-slate-50 px-4 py-2 text-left text-xs font-semibold text-slate-600"
                >
                  People working
                  <span className="block font-normal text-slate-500">
                    {formatHours(totalHours)} scheduled
                  </span>
                </th>
                <td className="p-0">
                  <div
                    className="grid"
                    style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}
                  >
                    {coverage.map((n, h) => {
                      // A gap: nobody, between hours that have someone.
                      const gap = n === 0 && h > first && h < last;
                      return (
                        <span
                          key={h}
                          title={`${hourLabel(h, timeFormat)}: ${n} ${n === 1 ? 'person' : 'people'} working${gap ? ' (a gap)' : ''}`}
                          className={cx(
                            'border-l border-slate-200/70 py-2.5 text-center text-xs font-semibold tabular-nums',
                            n > 0
                              ? 'text-slate-800'
                              : gap
                                ? 'bg-rose-50 text-rose-600'
                                : 'text-slate-300',
                          )}
                          style={
                            n > 0
                              ? {
                                  backgroundColor: `color-mix(in srgb, var(--color-brand-500) ${Math.round((n / peak) * 28) + 6}%, transparent)`,
                                }
                              : undefined
                          }
                        >
                          {n}
                        </span>
                      );
                    })}
                  </div>
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {footer}
    </Card>
  );
}

/** A shift across the hours, like a chip on the week view. */
function Bar({
  bar,
  tz,
  day,
  format,
}: {
  bar: TimelineBar;
  tz: string;
  day: ISODate;
  format: TimeFormat;
}) {
  const start = minutesIn(bar.startTime, tz, day);
  const end = Math.max(minutesIn(bar.endTime, tz, day), start + 30);
  const muted = 'var(--color-slate-300)';
  const edge = bar.removed ? muted : alpha(bar.color, bar.status === 'pending' ? 0.8 : 0.35);
  const clock = (iso: string) => {
    const t = localTime(iso, tz);
    return formatTimeOfDay(t, format, true);
  };
  const time = `${clock(bar.startTime)}–${clock(bar.endTime)}${localDate(bar.endTime, tz) > day ? ' (+1)' : ''}`;
  const Tag = bar.onClick ? 'button' : 'div';
  const statusText =
    bar.status === 'confirmed'
      ? 'confirmed'
      : bar.status === 'pending'
        ? 'waiting for confirmation'
        : 'draft';
  return (
    <Tag
      type={bar.onClick ? 'button' : undefined}
      onClick={
        bar.onClick &&
        ((e) => {
          e.stopPropagation();
          bar.onClick?.();
        })
      }
      draggable={bar.draggable}
      onDragStart={bar.onDragStart}
      onDragEnd={bar.onDragEnd}
      title={[time, bar.labelName, bar.notes].filter(Boolean).join(' · ')}
      aria-label={`${time}${bar.labelName ? `, ${bar.labelName}` : ''}, ${bar.removed ? 'will be removed' : statusText}`}
      className={cx(
        'group/chip absolute inset-y-1.5 z-10 min-w-0 rounded-md border px-2 py-1 text-left text-xs leading-tight transition dark:shadow-[0_0_14px_-7px_var(--chip)]',
        bar.status === 'pending' && !bar.removed ? 'border-dashed' : 'border-solid',
        bar.removed && 'opacity-60',
        bar.onClick && 'cursor-pointer hover:shadow-sm',
        bar.draggable && 'cursor-grab active:cursor-grabbing',
        bar.dragging && 'opacity-40',
      )}
      style={{
        ['--chip' as string]: bar.removed ? 'transparent' : bar.color,
        left: `${(start / DAY_MINUTES) * 100}%`,
        width: `${((end - start) / DAY_MINUTES) * 100}%`,
        backgroundColor: bar.removed ? 'var(--color-slate-50)' : alpha(bar.color, 0.14),
        // Longhands only: mixing border shorthands confuses React's style diffing.
        borderTopColor: edge,
        borderRightColor: edge,
        borderBottomColor: edge,
        borderLeftColor: bar.removed ? muted : bar.color,
        borderLeftWidth: 3,
        borderLeftStyle: 'solid',
      }}
    >
      <span className="flex items-center gap-1 overflow-hidden">
        <span
          className={cx('truncate font-semibold text-slate-800', bar.removed && 'line-through')}
        >
          {time}
        </span>
        {bar.status && !bar.removed && <StatusIcon status={bar.status} className="shrink-0" />}
        {bar.notes && !bar.removed && (
          <StickyNote className="size-3 shrink-0 text-slate-400" aria-label="Has a note" />
        )}
      </span>
      {(bar.labelName || bar.caption) && (
        <span
          className={cx(
            'mt-0.5 block truncate text-[11px] text-slate-600',
            bar.removed && 'line-through',
          )}
        >
          {bar.labelName}
          {bar.labelName && bar.caption ? ' · ' : ''}
          {bar.caption}
        </span>
      )}
      {bar.change && !bar.removed && (
        <span
          className={cx(
            'absolute -top-1.5 -right-1.5 rounded-full px-1 text-[9px] font-bold uppercase leading-4 text-white shadow-sm',
            bar.change === 'new' ? 'bg-emerald-500' : 'bg-amber-500',
          )}
        >
          {bar.change === 'new' ? 'New' : 'Edit'}
        </span>
      )}
      {bar.removed && bar.onRestore && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            bar.onRestore?.();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              bar.onRestore?.();
            }
          }}
          className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-semibold text-brand-600 hover:text-brand-500"
        >
          <Undo2 className="size-3" /> Undo remove
        </span>
      )}
    </Tag>
  );
}
