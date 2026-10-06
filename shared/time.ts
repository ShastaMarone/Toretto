import { DateTime, Settings } from 'luxon';
import type { WeekStart } from './types';

// Formatting below relies on en-US tokens ("AM"/"PM", "Mon", "Oct"); some
// locales (e.g. en-CA) would render "a.m." and break the compact formats.
Settings.defaultLocale = 'en-US';

/** A calendar day, 'YYYY-MM-DD'. */
export type ISODate = string;

// ---------------------------------------------------------------------------
// Calendar-day arithmetic (done in UTC so DST never shifts a day)
// ---------------------------------------------------------------------------

function day(date: ISODate): DateTime {
  const dt = DateTime.fromISO(date, { zone: 'UTC' });
  if (!dt.isValid) throw new Error(`Invalid date: ${date}`);
  return dt;
}

export function addDays(date: ISODate, days: number): ISODate {
  return day(date).plus({ days }).toISODate()!;
}

export function addMonths(date: ISODate, months: number): ISODate {
  return day(date).plus({ months }).toISODate()!;
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function diffDays(from: ISODate, to: ISODate): number {
  return Math.round(day(to).diff(day(from), 'days').days);
}

/** Every day from start to end, inclusive. */
export function eachDay(start: ISODate, end: ISODate): ISODate[] {
  const days: ISODate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}

/** 0 = Sunday ... 6 = Saturday */
export function dayOfWeek(date: ISODate): number {
  return day(date).weekday % 7;
}

export function startOfWeek(date: ISODate, weekStartsOn: WeekStart): ISODate {
  const offset = (dayOfWeek(date) - weekStartsOn + 7) % 7;
  return addDays(date, -offset);
}

export function startOfMonth(date: ISODate): ISODate {
  return day(date).startOf('month').toISODate()!;
}

export function endOfMonth(date: ISODate): ISODate {
  return day(date).endOf('month').toISODate()!;
}

export function isWeekend(date: ISODate): boolean {
  const dow = dayOfWeek(date);
  return dow === 0 || dow === 6;
}

// ---------------------------------------------------------------------------
// Timestamps <-> local wall-clock time in a zone
// ---------------------------------------------------------------------------

export function zoned(iso: string, tz: string): DateTime {
  return DateTime.fromISO(iso, { zone: tz });
}

export function todayIn(tz: string): ISODate {
  return DateTime.now().setZone(tz).toISODate()!;
}

/** The local calendar day of a timestamp in a zone. */
export function localDate(iso: string, tz: string): ISODate {
  return zoned(iso, tz).toISODate()!;
}

/** The local wall-clock time of a timestamp in a zone, 'HH:mm'. */
export function localTime(iso: string, tz: string): string {
  return zoned(iso, tz).toFormat('HH:mm');
}

/** Combine a local day and 'HH:mm' in a zone into a UTC ISO timestamp. */
export function combineDateTime(date: ISODate, time: string, tz: string): string {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: tz });
  if (!dt.isValid) throw new Error(`Invalid date/time: ${date} ${time}`);
  return dt.toUTC().toISO()!;
}

/** UTC bounds [from, to) covering the local days start..end in a zone. */
export function dayRangeToUtc(
  start: ISODate,
  end: ISODate,
  tz: string,
): { from: string; to: string } {
  return {
    from: DateTime.fromISO(start, { zone: tz }).startOf('day').toUTC().toISO()!,
    to: DateTime.fromISO(addDays(end, 1), { zone: tz }).startOf('day').toUTC().toISO()!,
  };
}

/**
 * Build a shift's UTC start/end from a local day and 'HH:mm' times. An end time
 * at or before the start time means the shift ends the next day (overnight).
 */
export function shiftTimesFromLocal(
  date: ISODate,
  startTime: string,
  endTime: string,
  tz: string,
): { startTime: string; endTime: string } {
  const endDate = endTime <= startTime ? addDays(date, 1) : date;
  return {
    startTime: combineDateTime(date, startTime, tz),
    endTime: combineDateTime(endDate, endTime, tz),
  };
}

/**
 * Move a shift to another local day, keeping its wall-clock start and end
 * times (a 9pm–7am shift stays 9pm–7am even across a DST change).
 */
export function moveShiftToDate(
  startIso: string,
  endIso: string,
  targetDate: ISODate,
  tz: string,
): { startTime: string; endTime: string } {
  const dayOffset = diffDays(localDate(startIso, tz), localDate(endIso, tz));
  return {
    startTime: combineDateTime(targetDate, localTime(startIso, tz), tz),
    endTime: combineDateTime(addDays(targetDate, dayOffset), localTime(endIso, tz), tz),
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** How clock times are written: "3:00 PM" (12-hour) or "15:00" (24-hour). */
export type TimeFormat = '12h' | '24h';

/** "9:00 AM", or "09:00" in 24-hour format. */
export function formatClock(iso: string, tz: string, format: TimeFormat = '12h'): string {
  return zoned(iso, tz).toFormat(format === '24h' ? 'HH:mm' : 'h:mm a');
}

/** "9am", "9:30am", or "09:00" in 24-hour format. */
export function formatClockShort(iso: string, tz: string, format: TimeFormat = '12h'): string {
  const dt = zoned(iso, tz);
  if (format === '24h') return dt.toFormat('HH:mm');
  const meridiem = dt.toFormat('a').toLowerCase();
  return dt.minute === 0 ? `${dt.toFormat('h')}${meridiem}` : `${dt.toFormat('h:mm')}${meridiem}`;
}

/**
 * "9:00 AM – 5:00 PM", or "9am–5pm" when short ("09:00 – 17:00" and
 * "09:00–17:00" in 24-hour format). Overnight shifts get "(+1)".
 */
export function formatTimeRange(
  startIso: string,
  endIso: string,
  tz: string,
  options: { short?: boolean; format?: TimeFormat } = {},
): string {
  const fmt = options.short ? formatClockShort : formatClock;
  const sep = options.short ? '–' : ' – ';
  const days = diffDays(localDate(startIso, tz), localDate(endIso, tz));
  const suffix = days > 0 ? ` (+${days})` : '';
  return `${fmt(startIso, tz, options.format)}${sep}${fmt(endIso, tz, options.format)}${suffix}`;
}

/**
 * Tightest form for small cells: "8am–4pm", "12–8pm" (shared am/pm
 * collapsed), or "8–16", "8:30–16" in 24-hour format.
 */
export function formatTimeRangeCompact(
  startIso: string,
  endIso: string,
  tz: string,
  format: TimeFormat = '12h',
): string {
  const start = zoned(startIso, tz);
  const end = zoned(endIso, tz);
  if (format === '24h') {
    const clock = (dt: DateTime) => (dt.minute === 0 ? dt.toFormat('H') : dt.toFormat('H:mm'));
    return `${clock(start)}–${clock(end)}`;
  }
  const clock = (dt: DateTime) => (dt.minute === 0 ? dt.toFormat('h') : dt.toFormat('h:mm'));
  const sm = start.toFormat('a').toLowerCase();
  const em = end.toFormat('a').toLowerCase();
  return sm === em && diffDays(localDate(startIso, tz), localDate(endIso, tz)) === 0
    ? `${clock(start)}–${clock(end)}${em}`
    : `${clock(start)}${sm}–${clock(end)}${em}`;
}

/** A wall-clock 'HH:mm' as "3:00 PM" (or "3pm" when short), or "15:00". */
export function formatTimeOfDay(time: string, format: TimeFormat = '12h', short = false): string {
  const [h = 0, m = 0] = time.split(':').map(Number);
  if (format === '24h') return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const hour = h % 12 || 12;
  const meridiem = h < 12 ? 'AM' : 'PM';
  if (short) return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''}${meridiem.toLowerCase()}`;
  return `${hour}:${String(m).padStart(2, '0')} ${meridiem}`;
}

/**
 * Read a typed time of day as 'HH:mm': "9", "9am", "9:30 pm", "930p",
 * "21:30", "2130", "noon", "midnight". Returns null if it isn't a time.
 * With `after` (an end time), an hour without am/pm that would land at or
 * before `after` means the afternoon instead ("5" after 09:00 is 17:00).
 */
export function parseTimeOfDay(text: string, options: { after?: string } = {}): string | null {
  const t = text.trim().toLowerCase().replace(/\./g, '');
  if (t === 'noon') return '12:00';
  if (t === 'midnight') return '00:00';
  const match = /^(\d{1,2})(?::?(\d{2}))?\s*(a|am|p|pm)?$/.exec(t);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.[0];
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === 'p' ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  let time = `${pad(hour)}:${pad(minute)}`;
  if (!meridiem && options.after && hour >= 1 && hour <= 11 && time <= options.after) {
    const afternoon = `${pad(hour + 12)}:${pad(minute)}`;
    if (afternoon > options.after) time = afternoon;
  }
  return time;
}

/** "Mon, Oct 6" (short) or "Monday, October 6, 2026" (long) */
export function formatDay(date: ISODate, style: 'short' | 'long' = 'short'): string {
  return day(date).toFormat(style === 'short' ? 'ccc, LLL d' : 'cccc, LLLL d, yyyy');
}

/** "Oct 6 – 12, 2026", "Sep 29 – Oct 5, 2026", "Dec 29, 2026 – Jan 4, 2027" */
export function formatDateRange(start: ISODate, end: ISODate): string {
  const a = day(start);
  const b = day(end);
  if (start === end) return a.toFormat('LLL d, yyyy');
  if (a.year !== b.year) return `${a.toFormat('LLL d, yyyy')} – ${b.toFormat('LLL d, yyyy')}`;
  if (a.month !== b.month) return `${a.toFormat('LLL d')} – ${b.toFormat('LLL d, yyyy')}`;
  return `${a.toFormat('LLL d')} – ${b.toFormat('d, yyyy')}`;
}

/** "Mon, Oct 6 · 9:00 AM – 5:00 PM" */
export function formatShiftWhen(
  startIso: string,
  endIso: string,
  tz: string,
  format: TimeFormat = '12h',
): string {
  return `${formatDay(localDate(startIso, tz))} · ${formatTimeRange(startIso, endIso, tz, { format })}`;
}

/** "Oct 6, 2026, 9:15 AM", or "Oct 6, 2026, 09:15" in 24-hour format. */
export function formatTimestamp(iso: string, tz: string, format: TimeFormat = '12h'): string {
  return zoned(iso, tz).toFormat(format === '24h' ? 'LLL d, yyyy, HH:mm' : 'LLL d, yyyy, h:mm a');
}

/** Short zone name at a moment, e.g. "EDT". */
export function tzAbbreviation(tz: string, atIso?: string): string {
  const dt = atIso ? zoned(atIso, tz) : DateTime.now().setZone(tz);
  return dt.toFormat('ZZZZ');
}

export function shiftHours(startIso: string, endIso: string): number {
  const ms = DateTime.fromISO(endIso).toMillis() - DateTime.fromISO(startIso).toMillis();
  return Math.round((ms / 3_600_000) * 100) / 100;
}

/** An unpaid break is only taken off shifts longer than this (Ontario's meal-break rule: after 5 hours). */
export const BREAK_AFTER_HOURS = 5;

/**
 * Hours that count for pay: the shift's length less its unpaid break (a lunch
 * that isn't paid). Short shifts have no break to take off.
 */
export function paidHours(startIso: string, endIso: string, unpaidBreakMinutes = 0): number {
  const hours = shiftHours(startIso, endIso);
  if (!unpaidBreakMinutes || hours <= BREAK_AFTER_HOURS) return hours;
  return Math.max(0, Math.round((hours - unpaidBreakMinutes / 60) * 100) / 100);
}

/** 8 -> "8h", 7.5 -> "7h 30m" */
export function formatHours(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (m === 0) return `${h}h`;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/** "3 hours ago" */
export function formatRelative(iso: string): string {
  return DateTime.fromISO(iso).toRelative() ?? '';
}
