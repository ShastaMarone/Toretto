import type { Holiday } from '@shared/holidays';
import { formatDay, type ISODate } from '@shared/time';
import type { PersonRow } from '@shared/types';
import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import type { PeopleGroup } from '../../lib/schedule';
import { Card } from '../ui/Misc';

/**
 * The schedule for phones: one block per day, listing only the people who have
 * something that day (shifts, time off), instead of a wide people × days grid
 * that has to be scrolled sideways. Pages supply the same pieces the grid uses.
 */
export function ScheduleAgenda({
  days,
  today,
  holidays,
  groups,
  hasContent,
  daySummary,
  renderPerson,
  renderCell,
  onAddDay,
  empty,
  footer,
}: {
  days: ISODate[];
  today: ISODate;
  holidays: Map<ISODate, Holiday[]>;
  groups: PeopleGroup[];
  /** Does this person have anything to show on this day? */
  hasContent: (person: PersonRow, day: ISODate) => boolean;
  daySummary: (day: ISODate) => ReactNode;
  renderPerson: (person: PersonRow) => ReactNode;
  renderCell: (person: PersonRow, day: ISODate) => ReactNode;
  /** Add a shift on this day (the dialog asks who). Omit when there's no one to add to. */
  onAddDay?: (day: ISODate) => void;
  empty?: ReactNode;
  footer?: ReactNode;
}) {
  if (groups.length === 0) {
    return (
      <Card className="px-4 py-10 text-center text-sm text-slate-500">
        {empty}
        {footer}
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {days.map((day) => {
        const rows = groups
          .map((group) => ({
            group,
            people: group.people.filter((p) => hasContent(p, day)),
          }))
          .filter((g) => g.people.length > 0);
        const holiday = holidays.get(day)?.[0];
        return (
          <Card
            key={day}
            className={cx('overflow-hidden', day === today && 'ring-2 ring-brand-300')}
          >
            <div
              className={cx(
                'flex items-center justify-between gap-3 border-b border-slate-200/70 px-4 py-2.5',
                day === today ? 'bg-brand-50' : 'bg-slate-50/70',
              )}
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">
                  {formatDay(day, 'long')}
                  {day === today && <span className="ml-2 text-xs text-brand-600">Today</span>}
                </p>
                {holiday && <p className="truncate text-xs text-rose-600">{holiday.name}</p>}
              </div>
              <span className="shrink-0 text-xs text-slate-500">{daySummary(day)}</span>
            </div>
            {rows.length === 0 ? (
              <p className="px-4 py-3 text-sm text-slate-400">No shifts</p>
            ) : (
              rows.map(({ group, people }) => (
                <div key={group.key}>
                  <p className="flex items-center gap-2 px-4 pt-2.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                    <span
                      className="size-2 rounded-full"
                      style={{ background: group.tier?.color ?? 'var(--color-slate-400)' }}
                    />
                    {group.tier?.name ?? 'No tier'}
                  </p>
                  {people.map((person) => (
                    <div key={person.id} className="px-4 py-2">
                      <div className="mb-1.5">{renderPerson(person)}</div>
                      {renderCell(person, day)}
                    </div>
                  ))}
                </div>
              ))
            )}
            {onAddDay && (
              <button
                type="button"
                onClick={() => onAddDay(day)}
                className="flex w-full items-center justify-center gap-1.5 border-t border-slate-100 px-4 py-2.5 text-sm font-medium text-brand-600 active:bg-brand-50"
              >
                <Plus className="size-4" /> Add a shift
              </button>
            )}
          </Card>
        );
      })}
      {footer}
    </div>
  );
}
