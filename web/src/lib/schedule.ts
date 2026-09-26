import {
  eachDay,
  formatDateRange,
  localDate,
  localTime,
  shiftHours,
  type ISODate,
} from '@shared/time';
import type { BuilderShift, ScheduleSummary, TimeOffEntry } from '@shared/types';
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

/** user id -> day -> time-off entry, for the given days. */
export function timeOffByUserDay(
  entries: TimeOffEntry[],
  days: ISODate[],
): Map<string, Map<ISODate, TimeOffEntry>> {
  const out = new Map<string, Map<ISODate, TimeOffEntry>>();
  const inRange = new Set(days);
  for (const entry of entries) {
    for (const day of eachDay(entry.startDate, entry.endDate)) {
      if (!inRange.has(day)) continue;
      let byDay = out.get(entry.userId);
      if (!byDay) out.set(entry.userId, (byDay = new Map()));
      // Approved beats pending if both exist.
      if (!byDay.has(day) || entry.status === 'approved') byDay.set(day, entry);
    }
  }
  return out;
}

export function totalHours(shifts: { startTime: string; endTime: string }[]): number {
  return shifts.reduce((sum, s) => sum + shiftHours(s.startTime, s.endTime), 0);
}

/** A schedule's display name: its custom name, else its date range. */
export function scheduleTitle(s: Pick<ScheduleSummary, 'name' | 'startDate' | 'endDate'>): string {
  return s.name || formatDateRange(s.startDate, s.endDate);
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
