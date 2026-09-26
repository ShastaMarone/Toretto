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

/** "9:00 AM" */
export function formatClock(iso: string, tz: string): string {
  return zoned(iso, tz).toFormat('h:mm a');
}

/** "9am", "9:30am" */
export function formatClockShort(iso: string, tz: string): string {
  const dt = zoned(iso, tz);
  const meridiem = dt.toFormat('a').toLowerCase();
  return dt.minute === 0 ? `${dt.toFormat('h')}${meridiem}` : `${dt.toFormat('h:mm')}${meridiem}`;
}

/** "9:00 AM – 5:00 PM", or "9am–5pm" when short. Overnight shifts get "(+1)". */
export function formatTimeRange(
  startIso: string,
  endIso: string,
  tz: string,
  options: { short?: boolean } = {},
): string {
  const fmt = options.short ? formatClockShort : formatClock;
  const sep = options.short ? '–' : ' – ';
  const days = diffDays(localDate(startIso, tz), localDate(endIso, tz));
  const suffix = days > 0 ? ` (+${days})` : '';
  return `${fmt(startIso, tz)}${sep}${fmt(endIso, tz)}${suffix}`;
}

/** Tightest form for small cells: "8am–4pm", "12–8pm" (shared am/pm collapsed). */
export function formatTimeRangeCompact(startIso: string, endIso: string, tz: string): string {
  const start = zoned(startIso, tz);
  const end = zoned(endIso, tz);
  const clock = (dt: DateTime) => (dt.minute === 0 ? dt.toFormat('h') : dt.toFormat('h:mm'));
  const sm = start.toFormat('a').toLowerCase();
  const em = end.toFormat('a').toLowerCase();
  return sm === em && diffDays(localDate(startIso, tz), localDate(endIso, tz)) === 0
    ? `${clock(start)}–${clock(end)}${em}`
    : `${clock(start)}${sm}–${clock(end)}${em}`;
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
export function formatShiftWhen(startIso: string, endIso: string, tz: string): string {
  return `${formatDay(localDate(startIso, tz))} · ${formatTimeRange(startIso, endIso, tz)}`;
}

/** Oct 6, 2026, 9:15 AM */
export function formatTimestamp(iso: string, tz: string): string {
  return zoned(iso, tz).toFormat('LLL d, yyyy, h:mm a');
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
