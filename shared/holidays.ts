// Canadian statutory (general) holidays for each jurisdiction, computed for
// any year. The lists follow each jurisdiction's employment standards: the
// Canada Labour Code for federally regulated employers, and the provincial and
// territorial acts elsewhere (as published on canada.ca and the provinces'
// sites). A fixed-date holiday that falls on a weekend also gets an
// "observed" day on the next free weekday.
import { addDays, dayOfWeek, type ISODate } from './time';

export type HolidayRegion =
  | 'none'
  | 'CA'
  | 'AB'
  | 'BC'
  | 'MB'
  | 'NB'
  | 'NL'
  | 'NS'
  | 'NT'
  | 'NU'
  | 'ON'
  | 'PE'
  | 'QC'
  | 'SK'
  | 'YT';

export const HOLIDAY_REGIONS: { value: HolidayRegion; label: string }[] = [
  { value: 'CA', label: 'Federally regulated (Canada Labour Code)' },
  { value: 'AB', label: 'Alberta' },
  { value: 'BC', label: 'British Columbia' },
  { value: 'MB', label: 'Manitoba' },
  { value: 'NB', label: 'New Brunswick' },
  { value: 'NL', label: 'Newfoundland and Labrador' },
  { value: 'NS', label: 'Nova Scotia' },
  { value: 'NT', label: 'Northwest Territories' },
  { value: 'NU', label: 'Nunavut' },
  { value: 'ON', label: 'Ontario' },
  { value: 'PE', label: 'Prince Edward Island' },
  { value: 'QC', label: 'Quebec' },
  { value: 'SK', label: 'Saskatchewan' },
  { value: 'YT', label: 'Yukon' },
  { value: 'none', label: "Don't show holidays" },
];

export interface Holiday {
  date: ISODate;
  name: string;
  /** The weekday a weekend holiday is observed on, rather than the day itself. */
  observed: boolean;
}

type Rule =
  | { fixed: [month: number, day: number]; observe: boolean }
  | { nth: [month: number, weekday: number, n: number] }
  | { mondayBefore: [month: number, day: number] }
  | { easter: number };

const RULES = {
  newYear: { fixed: [1, 1], observe: true },
  thirdMondayFeb: { nth: [2, 1, 3] },
  goodFriday: { easter: -2 },
  victoriaDay: { mondayBefore: [5, 25] },
  indigenousPeoples: { fixed: [6, 21], observe: false },
  stJeanBaptiste: { fixed: [6, 24], observe: true },
  canadaDay: { fixed: [7, 1], observe: true },
  nunavutDay: { fixed: [7, 9], observe: true },
  firstMondayAug: { nth: [8, 1, 1] },
  thirdMondayAug: { nth: [8, 1, 3] },
  labourDay: { nth: [9, 1, 1] },
  truthAndReconciliation: { fixed: [9, 30], observe: true },
  thanksgiving: { nth: [10, 1, 2] },
  remembranceDay: { fixed: [11, 11], observe: true },
  christmas: { fixed: [12, 25], observe: true },
  boxingDay: { fixed: [12, 26], observe: true },
} satisfies Record<string, Rule>;

type RuleKey = keyof typeof RULES;
type Entry = RuleKey | [RuleKey, string];

const NAMES: Record<RuleKey, string> = {
  newYear: 'New Year’s Day',
  thirdMondayFeb: 'Family Day',
  goodFriday: 'Good Friday',
  victoriaDay: 'Victoria Day',
  indigenousPeoples: 'National Indigenous Peoples Day',
  stJeanBaptiste: 'Saint-Jean-Baptiste Day',
  canadaDay: 'Canada Day',
  nunavutDay: 'Nunavut Day',
  firstMondayAug: 'Civic Holiday',
  thirdMondayAug: 'Discovery Day',
  labourDay: 'Labour Day',
  truthAndReconciliation: 'National Day for Truth and Reconciliation',
  thanksgiving: 'Thanksgiving',
  remembranceDay: 'Remembrance Day',
  christmas: 'Christmas Day',
  boxingDay: 'Boxing Day',
};

const REGIONS: Record<Exclude<HolidayRegion, 'none'>, Entry[]> = {
  CA: [
    'newYear',
    'goodFriday',
    'victoriaDay',
    'canadaDay',
    'labourDay',
    'truthAndReconciliation',
    'thanksgiving',
    'remembranceDay',
    'christmas',
    'boxingDay',
  ],
  AB: [
    'newYear',
    'thirdMondayFeb',
    'goodFriday',
    'victoriaDay',
    'canadaDay',
    'labourDay',
    'thanksgiving',
    'remembranceDay',
    'christmas',
  ],
  BC: [
    'newYear',
    'thirdMondayFeb',
    'goodFriday',
    'victoriaDay',
    'canadaDay',
    ['firstMondayAug', 'British Columbia Day'],
    'labourDay',
    'truthAndReconciliation',
    'thanksgiving',
    'remembranceDay',
    'christmas',
  ],
  MB: [
    'newYear',
    ['thirdMondayFeb', 'Louis Riel Day'],
    'goodFriday',
    'victoriaDay',
    'canadaDay',
    'labourDay',
    ['truthAndReconciliation', 'Orange Shirt Day'],
    'thanksgiving',
    'christmas',
  ],
  NB: [
    'newYear',
    'thirdMondayFeb',
    'goodFriday',
    'canadaDay',
    ['firstMondayAug', 'New Brunswick Day'],
    'labourDay',
    'remembranceDay',
    'christmas',
  ],
  NL: [
    'newYear',
    'goodFriday',
    ['canadaDay', 'Memorial Day / Canada Day'],
    'labourDay',
    'remembranceDay',
    'christmas',
  ],
  NS: [
    'newYear',
    ['thirdMondayFeb', 'Heritage Day'],
    'goodFriday',
    'canadaDay',
    'labourDay',
    'christmas',
  ],
  NT: [
    'newYear',
    'goodFriday',
    'victoriaDay',
    'indigenousPeoples',
    'canadaDay',
    'firstMondayAug',
    'labourDay',
    'truthAndReconciliation',
    'thanksgiving',
    'remembranceDay',
    'christmas',
  ],
  NU: [
    'newYear',
    'goodFriday',
    'victoriaDay',
    'canadaDay',
    'nunavutDay',
    'firstMondayAug',
    'labourDay',
    'thanksgiving',
    'remembranceDay',
    'christmas',
  ],
  ON: [
    'newYear',
    'thirdMondayFeb',
    'goodFriday',
    'victoriaDay',
    'canadaDay',
    'labourDay',
    'thanksgiving',
    'christmas',
    'boxingDay',
  ],
  PE: [
    'newYear',
    ['thirdMondayFeb', 'Islander Day'],
    'goodFriday',
    'canadaDay',
    'labourDay',
    'truthAndReconciliation',
    'remembranceDay',
    'christmas',
  ],
  QC: [
    'newYear',
    'goodFriday',
    ['victoriaDay', 'National Patriots’ Day'],
    'stJeanBaptiste',
    'canadaDay',
    'labourDay',
    'thanksgiving',
    'christmas',
  ],
  SK: [
    'newYear',
    'thirdMondayFeb',
    'goodFriday',
    'victoriaDay',
    'canadaDay',
    ['firstMondayAug', 'Saskatchewan Day'],
    'labourDay',
    'thanksgiving',
    'remembranceDay',
    'christmas',
  ],
  YT: [
    'newYear',
    'goodFriday',
    'victoriaDay',
    'indigenousPeoples',
    'canadaDay',
    'thirdMondayAug',
    'labourDay',
    'truthAndReconciliation',
    'thanksgiving',
    'remembranceDay',
    'christmas',
  ],
};

const iso = (year: number, month: number, day: number): ISODate =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/** Easter Sunday (Gregorian calendar, anonymous algorithm). */
export function easterSunday(year: number): ISODate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

function dateOf(rule: Rule, year: number): ISODate {
  if ('fixed' in rule) return iso(year, rule.fixed[0], rule.fixed[1]);
  if ('easter' in rule) return addDays(easterSunday(year), rule.easter);
  if ('mondayBefore' in rule) {
    const [month, day] = rule.mondayBefore;
    const before = addDays(iso(year, month, day), -1);
    return addDays(before, -((dayOfWeek(before) - 1 + 7) % 7));
  }
  const [month, weekday, n] = rule.nth;
  const first = iso(year, month, 1);
  return addDays(first, ((weekday - dayOfWeek(first) + 7) % 7) + (n - 1) * 7);
}

const isWeekendDay = (date: ISODate) => dayOfWeek(date) === 0 || dayOfWeek(date) === 6;

/** Holidays for one calendar year, in date order (observed days included). */
export function holidaysInYear(region: HolidayRegion, year: number): Holiday[] {
  if (region === 'none') return [];
  const actual = REGIONS[region].map((entry) => {
    const [key, name] = Array.isArray(entry) ? entry : [entry, NAMES[entry]];
    const rule: Rule = RULES[key];
    return { date: dateOf(rule, year), name, observe: 'fixed' in rule && rule.observe };
  });
  actual.sort((a, b) => a.date.localeCompare(b.date));
  // When Christmas is on a Sunday it's observed on Monday the 26th, and
  // Boxing Day (that Monday) moves to Tuesday.
  const christmasOnSunday = dayOfWeek(iso(year, 12, 25)) === 0;
  const yields = (h: { date: ISODate }) => christmasOnSunday && h.date === iso(year, 12, 26);
  const taken = new Set(
    actual.filter((h) => !isWeekendDay(h.date) && !yields(h)).map((h) => h.date),
  );
  const holidays: Holiday[] = actual.map(({ date, name }) => ({ date, name, observed: false }));
  for (const h of actual) {
    if (!h.observe || !(isWeekendDay(h.date) || yields(h))) continue;
    let day = addDays(h.date, 1);
    while (isWeekendDay(day) || taken.has(day)) day = addDays(day, 1);
    taken.add(day);
    holidays.push({ date: day, name: `${h.name} (observed)`, observed: true });
  }
  return holidays.sort((a, b) => a.date.localeCompare(b.date) || Number(a.observed));
}

/** Holidays from `from` to `to` inclusive, keyed by date. */
export function holidaysBetween(
  region: HolidayRegion,
  from: ISODate,
  to: ISODate,
): Map<ISODate, Holiday[]> {
  const out = new Map<ISODate, Holiday[]>();
  const firstYear = Number(from.slice(0, 4));
  const lastYear = Number(to.slice(0, 4));
  for (let year = firstYear; year <= lastYear; year++) {
    for (const h of holidaysInYear(region, year)) {
      if (h.date < from || h.date > to) continue;
      out.set(h.date, [...(out.get(h.date) ?? []), h]);
    }
  }
  return out;
}
