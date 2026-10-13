import type { Holiday } from '@shared/holidays';
import { isWeekend, type ISODate } from '@shared/time';
import type { PersonRow } from '@shared/types';
import { useState, type ReactNode, type TdHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';
import type { PeopleGroup } from '../../lib/schedule';
import { useScrollToToday } from '../../lib/useScrollToToday';
import { Card } from '../ui/Misc';
import { useGroupReorder } from '../../lib/useGroupReorder';
import { DayHeader, GroupRows } from './CalendarBits';

/**
 * People × days: day headers across the top, people grouped by tier down the
 * side (each tier can collapse), with weekends, holidays and today shaded.
 * Wide ranges scroll sideways, opening at today. Pages fill in the cells.
 */
export function ScheduleGrid({
  days,
  today,
  holidays,
  compact,
  groups,
  dayWidth,
  rowHeight,
  daySummary,
  groupHours,
  renderPerson,
  renderCell,
  cellProps,
  highlight,
  empty,
  footer,
  className,
  onReorderGroups,
}: {
  days: ISODate[];
  today: ISODate;
  holidays: Map<ISODate, Holiday[]>;
  /** Tighter layout for long ranges (a month). */
  compact: boolean;
  groups: PeopleGroup[];
  /** Narrowest a day column may get: [compact, normal], in pixels. */
  dayWidth: [number, number];
  /** Tailwind height class for each person's row. */
  rowHeight: string;
  daySummary: (day: ISODate) => ReactNode;
  groupHours: (group: PeopleGroup) => string;
  /** What goes in the sticky name column. */
  renderPerson: (person: PersonRow) => ReactNode;
  renderCell: (person: PersonRow, day: ISODate) => ReactNode;
  /** Extra attributes for a cell (drag and drop, extra classes). */
  cellProps?: (person: PersonRow, day: ISODate) => TdHTMLAttributes<HTMLTableCellElement>;
  /** Tint this person's row (e.g. "you"). */
  highlight?: (person: PersonRow) => boolean;
  /** Shown instead of rows when no one is in `groups`. */
  empty?: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Lets tiers be dragged into a new order; gets the new order of the group keys. */
  onReorderGroups?: (keys: string[]) => void;
}) {
  const groupDrag = useGroupReorder(
    groups.map((g) => g.key),
    onReorderGroups,
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const scroller = useScrollToToday<HTMLDivElement>(`${days[0]}:${days.at(-1)}`);
  const count = groups.reduce((n, g) => n + g.people.length, 0);
  const toggle = (key: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Card className={cx('overflow-hidden', className)}>
      <div ref={scroller} className="overflow-x-auto scrollbar-thin">
        <table
          className="w-full table-fixed border-collapse text-sm"
          style={{ minWidth: 200 + days.length * (compact ? dayWidth[0] : dayWidth[1]) }}
        >
          <colgroup>
            <col className="w-44 sm:w-52" />
            {days.map((d) => (
              <col key={d} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/70">
              <th
                scope="col"
                className="sticky left-0 z-10 bg-slate-50 px-4 py-2.5 text-left align-top text-xs font-semibold text-slate-500"
              >
                {count} {count === 1 ? 'person' : 'people'}
              </th>
              {days.map((d) => (
                <DayHeader
                  key={d}
                  day={d}
                  today={today}
                  holidays={holidays.get(d)}
                  compact={compact}
                  summary={daySummary(d)}
                />
              ))}
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
                  colSpan={days.length + 1}
                  collapsed={isCollapsed}
                  onToggle={() => toggle(group.key)}
                  drag={groupDrag(group.key)}
                >
                  {!isCollapsed &&
                    group.people.map((person) => {
                      const tinted = highlight?.(person) ?? false;
                      return (
                        <tr
                          key={person.id}
                          className={cx('border-b border-slate-100', tinted && 'bg-brand-50/40')}
                        >
                          <th
                            scope="row"
                            className={cx(
                              'sticky left-0 z-10 px-3 py-2 text-left font-normal sm:px-4',
                              tinted ? 'bg-brand-50' : 'bg-surface',
                            )}
                          >
                            {renderPerson(person)}
                          </th>
                          {days.map((day) => {
                            const { className: extra, ...props } = cellProps?.(person, day) ?? {};
                            return (
                              <td
                                key={day}
                                {...props}
                                className={cx(
                                  'border-l border-slate-100 p-1 align-top',
                                  rowHeight,
                                  isWeekend(day) && 'bg-slate-50/40',
                                  holidays.has(day) && 'bg-rose-50/30',
                                  day === today && 'bg-brand-50/40',
                                  extra,
                                )}
                              >
                                {renderCell(person, day)}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                </GroupRows>
              );
            })}
            {groups.length === 0 && empty && (
              <tr>
                <td
                  colSpan={days.length + 1}
                  className="px-4 py-10 text-center text-sm text-slate-500"
                >
                  {empty}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {footer}
    </Card>
  );
}
