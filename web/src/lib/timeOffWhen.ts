import { shiftTimesFromLocal, type ISODate } from '@shared/time';
import type { TimeOffSpan } from '@shared/timeOff';

/** What the time-off forms collect: whole days, or a day and a from/to time ('HH:mm'). */
export interface TimeOffWhen {
  partial: boolean;
  startDate: ISODate;
  endDate: ISODate;
  start: string;
  end: string;
}

export function initialWhen(day: ISODate): TimeOffWhen {
  return { partial: false, startDate: day, endDate: day, start: '09:00', end: '12:00' };
}

/** The request body's dates, or its start and end (a "to" at or before "from" ends the next day). */
export function whenPayload(when: TimeOffWhen, tz: string) {
  return when.partial
    ? shiftTimesFromLocal(when.startDate, when.start, when.end, tz)
    : { startDate: when.startDate, endDate: when.endDate };
}

export function whenSpan(when: TimeOffWhen, tz: string): TimeOffSpan {
  if (!when.partial) {
    return { startDate: when.startDate, endDate: when.endDate, startTime: null, endTime: null };
  }
  const { startTime, endTime } = whenPayload(when, tz) as { startTime: string; endTime: string };
  return { startDate: when.startDate, endDate: when.startDate, startTime, endTime };
}
