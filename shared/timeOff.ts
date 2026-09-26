import {
  dayRangeToUtc,
  diffDays,
  eachDay,
  formatDateRange,
  formatHours,
  formatShiftWhen,
  localDate,
  shiftHours,
  type ISODate,
  type TimeFormat,
} from './time';

/** When time off happens: whole days, or exact hours for part of a day. */
export interface TimeOffSpan {
  /** The calendar days it falls on. */
  startDate: ISODate;
  endDate: ISODate;
  /** Only for part of a day. */
  startTime: string | null;
  endTime: string | null;
}

export const isPartialDay = (
  span: TimeOffSpan,
): span is TimeOffSpan & {
  startTime: string;
  endTime: string;
} => span.startTime !== null && span.endTime !== null;

/** "Oct 12 – 14, 2026", or "Mon, Oct 12 · 1:00 PM – 3:00 PM" for part of a day. */
export function formatTimeOffWhen(span: TimeOffSpan, tz: string, format: TimeFormat = '12h') {
  return isPartialDay(span)
    ? formatShiftWhen(span.startTime, span.endTime, tz, format)
    : formatDateRange(span.startDate, span.endDate);
}

/** "3 days", or "2h 30m" for part of a day. */
export function timeOffLength(span: TimeOffSpan): string {
  if (isPartialDay(span)) return formatHours(shiftHours(span.startTime, span.endTime));
  const days = diffDays(span.startDate, span.endDate) + 1;
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** The instants [from, to) it covers: its hours, or whole days in `tz`. */
export function timeOffBounds(span: TimeOffSpan, tz: string): { from: string; to: string } {
  return isPartialDay(span)
    ? { from: span.startTime, to: span.endTime }
    : dayRangeToUtc(span.startDate, span.endDate, tz);
}

/** Whether it covers any part of [startIso, endIso), e.g. a shift. */
export function timeOffOverlaps(
  span: TimeOffSpan,
  startIso: string,
  endIso: string,
  tz: string,
): boolean {
  const { from, to } = timeOffBounds(span, tz);
  return Date.parse(from) < Date.parse(endIso) && Date.parse(to) > Date.parse(startIso);
}

/** The calendar days it shows on: its days, or the days its hours touch in `tz`. */
export function timeOffDays(span: TimeOffSpan, tz: string): ISODate[] {
  if (!isPartialDay(span)) return eachDay(span.startDate, span.endDate);
  const lastMoment = new Date(Date.parse(span.endTime) - 1).toISOString();
  return eachDay(localDate(span.startTime, tz), localDate(lastMoment, tz));
}
