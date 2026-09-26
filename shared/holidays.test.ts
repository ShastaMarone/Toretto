import { describe, expect, it } from 'vitest';
import { easterSunday, holidaysBetween, holidaysInYear } from './holidays';

const dates = (region: Parameters<typeof holidaysInYear>[0], year: number) =>
  holidaysInYear(region, year).map((h) => `${h.date} ${h.name}`);

describe('Canadian holidays', () => {
  it('lists the ten Canada Labour Code general holidays', () => {
    expect(dates('CA', 2026)).toEqual([
      '2026-01-01 New Year’s Day',
      '2026-04-03 Good Friday',
      '2026-05-18 Victoria Day',
      '2026-07-01 Canada Day',
      '2026-09-07 Labour Day',
      '2026-09-30 National Day for Truth and Reconciliation',
      '2026-10-12 Thanksgiving',
      '2026-11-11 Remembrance Day',
      '2026-12-25 Christmas Day',
      '2026-12-26 Boxing Day',
      '2026-12-28 Boxing Day (observed)',
    ]);
  });

  it('uses each province’s own holidays and names', () => {
    const bc = dates('BC', 2026);
    expect(bc).toContain('2026-02-16 Family Day');
    expect(bc).toContain('2026-08-03 British Columbia Day');
    expect(bc).not.toContain('2026-12-26 Boxing Day');
    expect(dates('QC', 2026)).toContain('2026-05-18 National Patriots’ Day');
    expect(dates('QC', 2026)).toContain('2026-06-24 Saint-Jean-Baptiste Day');
    expect(dates('MB', 2026)).toContain('2026-02-16 Louis Riel Day');
    expect(dates('YT', 2026)).toContain('2026-08-17 Discovery Day');
    expect(holidaysInYear('NL', 2026)).toHaveLength(6);
    expect(holidaysInYear('none', 2026)).toEqual([]);
  });

  it('observes weekend holidays on the next free weekday', () => {
    // 2027: Christmas on Saturday, Boxing Day on Sunday.
    expect(dates('ON', 2027).slice(-4)).toEqual([
      '2027-12-25 Christmas Day',
      '2027-12-26 Boxing Day',
      '2027-12-27 Christmas Day (observed)',
      '2027-12-28 Boxing Day (observed)',
    ]);
    // 2033: Christmas on Sunday takes Monday; Boxing Day moves to Tuesday.
    expect(dates('CA', 2033).slice(-4)).toEqual([
      '2033-12-25 Christmas Day',
      '2033-12-26 Boxing Day',
      '2033-12-26 Christmas Day (observed)',
      '2033-12-27 Boxing Day (observed)',
    ]);
    // A Saturday Canada Day is observed on Monday.
    expect(dates('AB', 2028)).toContain('2028-07-03 Canada Day (observed)');
  });

  it('computes Easter', () => {
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
    expect(easterSunday(2038)).toBe('2038-04-25');
  });

  it('finds holidays in a date range across years', () => {
    const found = holidaysBetween('ON', '2026-12-20', '2027-01-05');
    expect([...found.keys()]).toEqual(['2026-12-25', '2026-12-26', '2026-12-28', '2027-01-01']);
    expect(found.get('2026-12-28')![0]!.observed).toBe(true);
  });
});
