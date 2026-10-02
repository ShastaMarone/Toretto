import { overtimeReasons, weeklyHours, type OvertimeRules } from '@shared/overtime';
import { addDays, formatDay, formatHours, type ISODate } from '@shared/time';
import type { OrgSettings, WeekStart } from '@shared/types';

export function overtimeRules(settings: OrgSettings | undefined): OvertimeRules {
  return {
    dailyHours: settings?.overtimeDailyHours ?? null,
    weeklyHours: settings?.overtimeWeeklyHours ?? null,
  };
}

/**
 * Someone's overtime on the days from..to, and why: past the daily limit on
 * any day, and past the weekly limit in the weeks that are fully shown (a
 * partly shown week can't say).
 */
export function overtimeIn(
  shifts: { startTime: string; endTime: string; unpaidBreakMinutes?: number }[],
  from: ISODate,
  to: ISODate,
  tz: string,
  weekStartsOn: WeekStart,
  rules: OvertimeRules,
): { hours: number; reasons: string[] } {
  let hours = 0;
  const reasons: string[] = [];
  for (const week of weeklyHours(shifts, tz, weekStartsOn, rules)) {
    const whole = week.start >= from && addDays(week.start, 6) <= to;
    const counted = whole
      ? week
      : { ...week, overtime: week.overtime - week.weeklyOvertime, weeklyOvertime: 0 };
    hours += counted.overtime;
    reasons.push(...overtimeReasons(counted, rules, formatDay, formatHours));
  }
  return { hours: Math.round(hours * 100) / 100, reasons };
}
