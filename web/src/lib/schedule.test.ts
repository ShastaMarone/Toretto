import { shiftTimesFromLocal } from '@shared/time';
import type { TimeOffEntry } from '@shared/types';
import { describe, expect, it } from 'vitest';
import {
  groupByDay,
  groupByTier,
  groupByUserDay,
  stepView,
  timeOffByUserDay,
  totalHours,
  viewRange,
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

  it('spreads time off across the days it covers, and part-day time off by its hours', () => {
    const entry = (
      id: string,
      start: string,
      end: string,
      hours?: { startTime: string; endTime: string },
    ): TimeOffEntry => ({
      id,
      userId: 'ana',
      startDate: start,
      endDate: end,
      startTime: hours?.startTime ?? null,
      endTime: hours?.endTime ?? null,
      status: 'approved',
      typeName: 'Vacation',
      typeColor: '#10b981',
    });
    const days = ['2026-10-05', '2026-10-06', '2026-10-07'];
    const afternoon = shiftTimesFromLocal('2026-10-07', '13:00', '15:00', TZ);
    const morning = shiftTimesFromLocal('2026-10-07', '09:00', '10:00', TZ);
    // 11 PM to 1 AM in Toronto: two days there, but one in Vancouver.
    const lateNight = shiftTimesFromLocal('2026-10-05', '23:00', '01:00', TZ);
    const list = [
      entry('trip', '2026-10-01', '2026-10-06'),
      entry('pm', '2026-10-07', '2026-10-07', afternoon),
      entry('am', '2026-10-07', '2026-10-07', morning),
      entry('night', '2026-10-05', '2026-10-06', lateNight),
    ];
    const ids = (byDay: Map<string, TimeOffEntry[]>, day: string) =>
      (byDay.get(day) ?? []).map((e) => e.id);
    const toronto = timeOffByUserDay(list, days, TZ).get('ana')!;
    expect(ids(toronto, '2026-10-05')).toEqual(['trip', 'night']);
    expect(ids(toronto, '2026-10-06')).toEqual(['trip', 'night']);
    // Whole days first, then by start time.
    expect(ids(toronto, '2026-10-07')).toEqual(['am', 'pm']);
    expect(toronto.has('2026-10-08')).toBe(false); // outside the visible days
    const vancouver = timeOffByUserDay(list, days, 'America/Vancouver').get('ana')!;
    expect(ids(vancouver, '2026-10-06')).toEqual(['trip']);
  });

  it('totals hours and titles schedules', () => {
    expect(
      totalHours([
        shift('a', '2026-10-06', '09:00', '17:00'),
        shift('a', '2026-10-07', '22:00', '06:30'),
      ]),
    ).toBe(16.5);
  });

  it('works out the days each calendar view shows', () => {
    // Thursday Oct 8, 2026, weeks starting Monday.
    expect(viewRange('day', '2026-10-08', 1)).toEqual({ from: '2026-10-08', to: '2026-10-08' });
    expect(stepView('day', '2026-10-31', 1)).toBe('2026-11-01');
    expect(stepView('day', '2026-03-01', -1)).toBe('2026-02-28');
    expect(viewRange('week', '2026-10-08', 1)).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(viewRange('2weeks', '2026-10-08', 0)).toEqual({ from: '2026-10-04', to: '2026-10-17' });
    expect(viewRange('month', '2026-10-08', 1)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(stepView('week', '2026-10-08', 1)).toBe('2026-10-15');
    expect(stepView('2weeks', '2026-10-08', -1)).toBe('2026-09-24');
    expect(stepView('month', '2026-10-31', 1)).toBe('2026-11-01');
    expect(stepView('month', '2026-03-01', -1)).toBe('2026-02-01');
  });

  it('groups people by tier in tier order, with no-tier people last', () => {
    const tiers = [
      { id: 't2', name: 'Tier 2', color: '#0891b2' },
      { id: 't1', name: 'Tier 1', color: '#4f46e5' },
    ];
    const person = (id: string, name: string, tierId: string | null) => ({
      id,
      name,
      tierId,
      teamId: null,
      active: true,
    });
    const groups = groupByTier(
      [
        person('a', 'Zoe', 't1'),
        person('b', 'Amy', 't1'),
        person('c', 'Cal', null),
        person('d', 'Dee', 't2'),
      ],
      tiers,
      'a',
    );
    expect(groups.map((g) => [g.key, g.people.map((p) => p.name)])).toEqual([
      ['t2', ['Dee']],
      ['t1', ['Zoe', 'Amy']], // the viewer first
      ['none', ['Cal']],
    ]);
  });
});
