import { localDate, paidHours, startOfWeek, type ISODate } from './time';
import type { WeekStart } from './types';

/** Hours before overtime: in a day, and in a week (null: no limit). */
export interface OvertimeRules {
  dailyHours: number | null;
  weeklyHours: number | null;
}

export interface DayTotal {
  date: ISODate;
  hours: number;
  /** Past the daily limit. */
  overtime: number;
}

export interface WeekTotal {
  /** The week's first day. */
  start: ISODate;
  hours: number;
  /** Past the daily limit on any day, plus past the weekly limit (not counting those twice). */
  overtime: number;
  /** The weekly part of `overtime`. */
  weeklyOvertime: number;
  /** Days with hours, in order. */
  days: DayTotal[];
}

const round = (n: number) => Math.round(n * 100) / 100;
const sum = (list: number[]) => round(list.reduce((a, b) => a + b, 0));

/**
 * One person's hours per week, with overtime. A shift counts toward the day
 * (and week) it starts on, in `tz`. Hours already over the daily limit aren't
 * counted again toward the weekly limit, e.g. four 10-hour days with 8/40
 * limits are 8 hours of overtime, not 8 + 0 + more.
 */
export function weeklyHours(
  shifts: { startTime: string; endTime: string; unpaidBreakMinutes?: number }[],
  tz: string,
  weekStartsOn: WeekStart,
  rules: OvertimeRules,
): WeekTotal[] {
  const byDay = new Map<ISODate, number>();
  for (const s of shifts) {
    const day = localDate(s.startTime, tz);
    byDay.set(day, (byDay.get(day) ?? 0) + paidHours(s.startTime, s.endTime, s.unpaidBreakMinutes));
  }
  const weeks = new Map<ISODate, DayTotal[]>();
  for (const [date, raw] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
    const hours = round(raw);
    const overtime = rules.dailyHours === null ? 0 : round(Math.max(0, hours - rules.dailyHours));
    const start = startOfWeek(date, weekStartsOn);
    weeks.set(start, [...(weeks.get(start) ?? []), { date, hours, overtime }]);
  }
  return [...weeks].map(([start, days]) => {
    const hours = sum(days.map((d) => d.hours));
    const daily = sum(days.map((d) => d.overtime));
    const weeklyOvertime =
      rules.weeklyHours === null ? 0 : round(Math.max(0, hours - daily - rules.weeklyHours));
    return { start, hours, overtime: round(daily + weeklyOvertime), weeklyOvertime, days };
  });
}

/** "10h on Tue, Oct 6 (2h over 8h)"-style lines explaining a week's overtime. */
export function overtimeReasons(
  week: WeekTotal,
  rules: OvertimeRules,
  formatDate: (date: ISODate) => string,
  formatHours: (hours: number) => string,
): string[] {
  const lines = week.days
    .filter((d) => d.overtime > 0)
    .map(
      (d) =>
        `${formatDate(d.date)}: ${formatHours(d.hours)} (${formatHours(d.overtime)} over ${formatHours(rules.dailyHours!)})`,
    );
  if (week.weeklyOvertime > 0) {
    lines.push(
      `Week of ${formatDate(week.start)}: ${formatHours(week.hours)} (${formatHours(week.weeklyOvertime)} over ${formatHours(rules.weeklyHours!)}${lines.length ? ', after daily overtime' : ''})`,
    );
  }
  return lines;
}
