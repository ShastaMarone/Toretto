import { timeOffDays } from '@shared/timeOff';
import {
  addDays,
  endOfMonth,
  localDate,
  localTime,
  shiftHours,
  startOfMonth,
  startOfWeek,
  type ISODate,
} from '@shared/time';
import type {
  BuilderShift,
  PersonRow,
  ShiftView,
  Tier,
  TimeOffEntry,
  WeekStart,
} from '@shared/types';
import type { ShiftDraft } from '../components/schedule/ShiftDialog';

/** Group items by user id, then by local day of their start time. */
export function groupByUserDay<T extends { userId: string; startTime: string }>(
  items: T[],
  tz: string,
): Map<string, Map<ISODate, T[]>> {
  const out = new Map<string, Map<ISODate, T[]>>();
  for (const item of items) {
    const day = localDate(item.startTime, tz);
    let byDay = out.get(item.userId);
    if (!byDay) out.set(item.userId, (byDay = new Map()));
    byDay.set(day, [...(byDay.get(day) ?? []), item]);
  }
  for (const byDay of out.values()) {
    for (const list of byDay.values()) list.sort((a, b) => a.startTime.localeCompare(b.startTime));
  }
  return out;
}

export function groupByDay<T extends { startTime: string }>(
  items: T[],
  tz: string,
): Map<ISODate, T[]> {
  const out = new Map<ISODate, T[]>();
  for (const item of [...items].sort((a, b) => a.startTime.localeCompare(b.startTime))) {
    const day = localDate(item.startTime, tz);
    out.set(day, [...(out.get(day) ?? []), item]);
  }
  return out;
}

/**
 * user id -> day -> time off that day (for the given days): whole days first,
 * then part-day time off by its start, placed by its hours in `tz`.
 */
export function timeOffByUserDay(
  entries: TimeOffEntry[],
  days: ISODate[],
  tz: string,
): Map<string, Map<ISODate, TimeOffEntry[]>> {
  const out = new Map<string, Map<ISODate, TimeOffEntry[]>>();
  const inRange = new Set(days);
  const order = (e: TimeOffEntry) => e.startTime ?? '';
  for (const entry of [...entries].sort((a, b) => order(a).localeCompare(order(b)))) {
    for (const day of timeOffDays(entry, tz)) {
      if (!inRange.has(day)) continue;
      let byDay = out.get(entry.userId);
      if (!byDay) out.set(entry.userId, (byDay = new Map()));
      byDay.set(day, [...(byDay.get(day) ?? []), entry]);
    }
  }
  return out;
}

/** A published shift's accent color: its label's, else its person's tier's. */
export function shiftColor(s: Pick<ShiftView, 'label' | 'tier'>): string {
  return s.label?.color ?? s.tier?.color ?? '#a855f7';
}

export function totalHours(shifts: { startTime: string; endTime: string }[]): number {
  return shifts.reduce((sum, s) => sum + shiftHours(s.startTime, s.endTime), 0);
}

export type CalendarView = 'week' | '2weeks' | 'month';

/** The days a calendar view shows around `date`. */
export function viewRange(
  view: CalendarView,
  date: ISODate,
  weekStartsOn: WeekStart,
): { from: ISODate; to: ISODate } {
  if (view === 'month') return { from: startOfMonth(date), to: endOfMonth(date) };
  const from = startOfWeek(date, weekStartsOn);
  return { from, to: addDays(from, view === 'week' ? 6 : 13) };
}

/** Move a view one step back or forward. */
export function stepView(view: CalendarView, date: ISODate, direction: 1 | -1): ISODate {
  if (view === 'month') return startOfMonth(addDays(startOfMonth(date), direction === 1 ? 32 : -1));
  return addDays(date, direction * (view === 'week' ? 7 : 14));
}

export interface PeopleGroup {
  key: string;
  tier: Pick<Tier, 'id' | 'name' | 'color'> | null;
  people: PersonRow[];
}

/** People grouped by tier (in tier order), people without a tier last. */
export function groupByTier(
  people: PersonRow[],
  tiers: Pick<Tier, 'id' | 'name' | 'color'>[],
  firstId?: string,
): PeopleGroup[] {
  const groups: PeopleGroup[] = tiers.map((t) => ({ key: t.id, tier: t, people: [] }));
  const other: PeopleGroup = { key: 'none', tier: null, people: [] };
  for (const person of people) {
    (groups.find((g) => g.key === person.tierId) ?? other).people.push(person);
  }
  for (const g of [...groups, other]) {
    g.people.sort((a, b) =>
      a.id === firstId ? -1 : b.id === firstId ? 1 : a.name.localeCompare(b.name),
    );
  }
  return [...groups, other].filter((g) => g.people.length > 0);
}

/** Dialog values for editing an existing shift. */
export function draftFromShift(shift: BuilderShift, tz: string): ShiftDraft {
  return {
    userId: shift.userId,
    date: localDate(shift.startTime, tz),
    start: localTime(shift.startTime, tz),
    end: localTime(shift.endTime, tz),
    labelId: shift.labelId,
    notes: shift.notes ?? '',
  };
}
