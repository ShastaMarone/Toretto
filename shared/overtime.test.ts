import { describe, expect, it } from 'vitest';
import { overtimeReasons, weeklyHours, type OvertimeRules } from './overtime';
import { addDays, formatDay, formatHours, shiftTimesFromLocal } from './time';

const TZ = 'America/Toronto';
const LABOUR_CODE: OvertimeRules = { dailyHours: 8, weeklyHours: 40 };
// Sunday, October 4, 2026: weeks start on Sunday here.
const SUNDAY = '2026-10-04';
const on = (day: number, start: string, end: string) =>
  shiftTimesFromLocal(addDays(SUNDAY, day), start, end, TZ);

describe('weeklyHours', () => {
  it('has no overtime for five 8-hour days', () => {
    const shifts = [1, 2, 3, 4, 5].map((d) => on(d, '09:00', '17:00'));
    const [week] = weeklyHours(shifts, TZ, 0, LABOUR_CODE);
    expect(week).toMatchObject({ start: SUNDAY, hours: 40, overtime: 0, weeklyOvertime: 0 });
    expect(week!.days).toHaveLength(5);
  });

  it('counts hours past 8 in a day', () => {
    const shifts = [on(1, '08:00', '18:30'), on(2, '09:00', '17:00')];
    const [week] = weeklyHours(shifts, TZ, 0, LABOUR_CODE);
    expect(week!.days[0]).toEqual({ date: addDays(SUNDAY, 1), hours: 10.5, overtime: 2.5 });
    expect(week).toMatchObject({ hours: 18.5, overtime: 2.5, weeklyOvertime: 0 });
  });

  it('counts hours past 40 in a week', () => {
    const shifts = [0, 1, 2, 3, 4, 5].map((d) => on(d, '09:00', '17:00'));
    expect(weeklyHours(shifts, TZ, 0, LABOUR_CODE)[0]).toMatchObject({
      hours: 48,
      overtime: 8,
      weeklyOvertime: 8,
    });
  });

  it("doesn't count daily overtime again toward the week", () => {
    // Four 10-hour days: 40 hours, but 8 of them are already daily overtime.
    const tens = [1, 2, 3, 4].map((d) => on(d, '08:00', '18:00'));
    expect(weeklyHours(tens, TZ, 0, LABOUR_CODE)[0]).toMatchObject({
      hours: 40,
      overtime: 8,
      weeklyOvertime: 0,
    });
    // Five 10-hour days: 10 daily, and 40 regular hours is right at the limit.
    const five = [1, 2, 3, 4, 5].map((d) => on(d, '08:00', '18:00'));
    expect(weeklyHours(five, TZ, 0, LABOUR_CODE)[0]).toMatchObject({ hours: 50, overtime: 10 });
    // Six: 12 daily, then 48 regular hours is 8 over the week.
    const six = [0, 1, 2, 3, 4, 5].map((d) => on(d, '08:00', '18:00'));
    expect(weeklyHours(six, TZ, 0, LABOUR_CODE)[0]).toMatchObject({
      hours: 60,
      overtime: 20,
      weeklyOvertime: 8,
    });
  });

  it('adds up shifts on the same day, and counts overnight shifts on the day they start', () => {
    const shifts = [on(1, '06:00', '10:00'), on(1, '14:00', '19:00'), on(2, '22:00', '07:00')];
    const [week] = weeklyHours(shifts, TZ, 0, LABOUR_CODE);
    expect(week!.days).toEqual([
      { date: addDays(SUNDAY, 1), hours: 9, overtime: 1 },
      { date: addDays(SUNDAY, 2), hours: 9, overtime: 1 },
    ]);
  });

  it('splits weeks on the chosen first day, and can go without either limit', () => {
    const shifts = [on(0, '09:00', '19:00'), on(1, '09:00', '19:00')];
    // Weeks starting Monday: Sunday belongs to the week before.
    const weeks = weeklyHours(shifts, TZ, 1, LABOUR_CODE);
    expect(weeks.map((w) => w.start)).toEqual([addDays(SUNDAY, -6), addDays(SUNDAY, 1)]);
    const none = weeklyHours(shifts, TZ, 0, { dailyHours: null, weeklyHours: null });
    expect(none[0]).toMatchObject({ hours: 20, overtime: 0 });
  });

  it('explains overtime in words', () => {
    const shifts = [0, 1, 2, 3, 4]
      .map((d) => on(d, '08:00', '18:00'))
      .concat(on(5, '09:00', '13:00'));
    const [week] = weeklyHours(shifts, TZ, 0, LABOUR_CODE);
    expect(overtimeReasons(week!, LABOUR_CODE, formatDay, formatHours)).toEqual([
      'Sun, Oct 4: 10h (2h over 8h)',
      'Mon, Oct 5: 10h (2h over 8h)',
      'Tue, Oct 6: 10h (2h over 8h)',
      'Wed, Oct 7: 10h (2h over 8h)',
      'Thu, Oct 8: 10h (2h over 8h)',
      'Week of Sun, Oct 4: 54h (4h over 40h, after daily overtime)',
    ]);
  });
});
