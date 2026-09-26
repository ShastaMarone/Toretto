import { shiftTimesFromLocal } from '@shared/time';
import type { TimeOffEntry } from '@shared/types';
import { describe, expect, it } from 'vitest';
import {
  groupByDay,
  groupByUserDay,
  scheduleTitle,
  timeOffByUserDay,
  totalHours,
} from './schedule';

const TZ = 'America/Toronto';
const shift = (userId: string, date: string, start: string, end: string) => ({
  userId,
  ...shiftTimesFromLocal(date, start, end, TZ),
});

describe('schedule grid helpers', () => {
  it('groups shifts by person and local day, sorted by start time', () => {
    const late = shift('ana', '2026-10-06', '13:00', '17:00');
    const early = shift('ana', '2026-10-06', '08:00', '12:00');
    // 11pm Toronto is already the next day in UTC; it must stay on the 6th.
    const night = shift('ben', '2026-10-06', '23:00', '23:30');
    const grouped = groupByUserDay([late, early, night], TZ);
    expect(grouped.get('ana')?.get('2026-10-06')).toEqual([early, late]);
    expect([...(grouped.get('ben')?.keys() ?? [])]).toEqual(['2026-10-06']);
    expect([...groupByDay([late, night, early], TZ).keys()]).toEqual(['2026-10-06']);
  });

  it('spreads time off across days, preferring approved over pending', () => {
    const entry = (
      id: string,
      status: 'pending' | 'approved',
      start: string,
      end: string,
    ): TimeOffEntry => ({
      id,
      userId: 'ana',
      startDate: start,
      endDate: end,
      status,
      typeName: 'Vacation',
      typeColor: '#10b981',
    });
    const days = ['2026-10-05', '2026-10-06', '2026-10-07'];
    const byDay = timeOffByUserDay(
      [
        entry('p', 'pending', '2026-10-06', '2026-10-09'),
        entry('a', 'approved', '2026-10-01', '2026-10-06'),
      ],
      days,
    ).get('ana')!;
    expect(byDay.get('2026-10-05')?.id).toBe('a');
    expect(byDay.get('2026-10-06')?.id).toBe('a');
    expect(byDay.get('2026-10-07')?.id).toBe('p');
    expect(byDay.has('2026-10-08')).toBe(false); // outside the visible days
  });

  it('totals hours and titles schedules', () => {
    expect(
      totalHours([
        shift('a', '2026-10-06', '09:00', '17:00'),
        shift('a', '2026-10-07', '22:00', '06:30'),
      ]),
    ).toBe(16.5);
    expect(scheduleTitle({ name: null, startDate: '2026-10-05', endDate: '2026-10-11' })).toBe(
      'Oct 5 – 11, 2026',
    );
    expect(
      scheduleTitle({ name: 'Holiday coverage', startDate: '2026-10-05', endDate: '2026-10-11' }),
    ).toBe('Holiday coverage');
  });
});
