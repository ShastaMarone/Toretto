import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayRangeToUtc,
  diffDays,
  eachDay,
  formatDateRange,
  formatHours,
  formatTimeRange,
  formatTimeRangeCompact,
  localDate,
  moveShiftToDate,
  shiftHours,
  shiftTimesFromLocal,
  startOfWeek,
} from './time';

const TZ = 'America/Toronto';

describe('calendar days', () => {
  it('adds and diffs days across month and DST boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02'); // DST ends Nov 1 in Toronto
    expect(diffDays('2026-10-06', '2026-10-12')).toBe(6);
    expect(eachDay('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
  });

  it('finds the start of the week for Monday and Sunday weeks', () => {
    // 2026-10-08 is a Thursday
    expect(startOfWeek('2026-10-08', 1)).toBe('2026-10-05');
    expect(startOfWeek('2026-10-08', 0)).toBe('2026-10-04');
    expect(startOfWeek('2026-10-05', 1)).toBe('2026-10-05');
    expect(startOfWeek('2026-10-04', 1)).toBe('2026-09-28');
  });

  it('formats date ranges compactly', () => {
    expect(formatDateRange('2026-10-05', '2026-10-11')).toBe('Oct 5 – 11, 2026');
    expect(formatDateRange('2026-09-28', '2026-10-04')).toBe('Sep 28 – Oct 4, 2026');
    expect(formatDateRange('2026-12-28', '2027-01-03')).toBe('Dec 28, 2026 – Jan 3, 2027');
    expect(formatDateRange('2026-10-05', '2026-10-05')).toBe('Oct 5, 2026');
  });
});

describe('shift times', () => {
  it('builds UTC times from local wall-clock times, handling overnight shifts', () => {
    const day = shiftTimesFromLocal('2026-10-06', '09:00', '17:00', TZ);
    expect(day).toEqual({
      startTime: '2026-10-06T13:00:00.000Z',
      endTime: '2026-10-06T21:00:00.000Z',
    });
    const night = shiftTimesFromLocal('2026-10-06', '22:00', '06:00', TZ);
    expect(night.endTime).toBe('2026-10-07T10:00:00.000Z');
    expect(shiftHours(night.startTime, night.endTime)).toBe(8);
  });

  it('formats time ranges in the viewer zone', () => {
    const { startTime, endTime } = shiftTimesFromLocal('2026-10-06', '09:00', '17:30', TZ);
    expect(formatTimeRange(startTime, endTime, TZ)).toBe('9:00 AM – 5:30 PM');
    expect(formatTimeRange(startTime, endTime, TZ, { short: true })).toBe('9am–5:30pm');
    expect(formatTimeRange(startTime, endTime, 'America/Vancouver', { short: true })).toBe(
      '6am–2:30pm',
    );
    const night = shiftTimesFromLocal('2026-10-06', '22:00', '06:00', TZ);
    expect(formatTimeRange(night.startTime, night.endTime, TZ, { short: true })).toBe(
      '10pm–6am (+1)',
    );
  });

  it('formats compact ranges for small calendar cells', () => {
    const noon = shiftTimesFromLocal('2026-10-06', '12:00', '20:00', TZ);
    expect(formatTimeRangeCompact(noon.startTime, noon.endTime, TZ)).toBe('12–8pm');
    const day = shiftTimesFromLocal('2026-10-06', '08:00', '16:30', TZ);
    expect(formatTimeRangeCompact(day.startTime, day.endTime, TZ)).toBe('8am–4:30pm');
    const night = shiftTimesFromLocal('2026-10-06', '21:00', '23:00', TZ);
    expect(formatTimeRangeCompact(night.startTime, night.endTime, TZ)).toBe('9–11pm');
  });

  it('moves a shift to another day keeping wall-clock times across DST', () => {
    // Oct 31 -> Nov 1 overnight shift, moved onto the DST-change night.
    const { startTime, endTime } = shiftTimesFromLocal('2026-10-24', '21:00', '07:00', TZ);
    const moved = moveShiftToDate(startTime, endTime, '2026-10-31', TZ);
    expect(formatTimeRange(moved.startTime, moved.endTime, TZ)).toBe('9:00 PM – 7:00 AM (+1)');
    expect(localDate(moved.startTime, TZ)).toBe('2026-10-31');
    expect(shiftHours(moved.startTime, moved.endTime)).toBe(11); // the clocks fell back
  });

  it('converts a local day range to UTC bounds', () => {
    expect(dayRangeToUtc('2026-10-05', '2026-10-11', TZ)).toEqual({
      from: '2026-10-05T04:00:00.000Z',
      to: '2026-10-12T04:00:00.000Z',
    });
  });

  it('formats hours', () => {
    expect(formatHours(8)).toBe('8h');
    expect(formatHours(7.5)).toBe('7h 30m');
    expect(formatHours(0.25)).toBe('15m');
  });
});
