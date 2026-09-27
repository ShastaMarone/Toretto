import { isPartialDay, type TimeOffSpan } from '@shared/timeOff';
import type { ShiftView } from '@shared/types';
import type { Config } from '../config';
import type { Queryable } from '../db';
import { icsCalendar, type IcsEvent } from '../lib/ics';
import { getSettings } from './settings';
import { myShifts } from './views';

/** How far back and ahead a feed reaches. */
const DAYS_BACK = 90;
const DAYS_AHEAD = 366;
const DAY_MS = 86_400_000;

/** Feed links are the token plus `.ics`, which some calendar apps expect. */
export const FEED_FILE = /^([A-Za-z0-9_-]{43})\.ics$/;

export function calendarFeedUrl(config: Config, token: string): string {
  return `${config.appUrl}/api/calendar/${token}.ics`;
}

/**
 * The calendar file for a feed link: that person's published shifts (never
 * drafts) and approved time off. Null when no active account has the link.
 */
export async function calendarFeed(
  db: Queryable,
  config: Config,
  token: string,
  now = new Date(),
): Promise<string | null> {
  const { rows: users } = await db.query<{ id: string }>(
    'SELECT id FROM users WHERE calendar_token = $1 AND deactivated_at IS NULL',
    [token],
  );
  const user = users[0];
  if (!user) return null;

  const from = new Date(now.getTime() - DAYS_BACK * DAY_MS).toISOString();
  const to = new Date(now.getTime() + DAYS_AHEAD * DAY_MS).toISOString();
  const [settings, shifts, timeOff, scheduleCount] = await Promise.all([
    getSettings(db),
    myShifts(db, user.id, { from, to }),
    db.query<TimeOffSpan & { id: string; note: string | null; type: string }>(
      `SELECT r.id, r.start_date AS "startDate", r.end_date AS "endDate",
              r.start_time AS "startTime", r.end_time AS "endTime", r.note, tt.name AS type
         FROM time_off_requests r JOIN time_off_types tt ON tt.id = r.type_id
        WHERE r.user_id = $1 AND r.status = 'approved'
          AND r.end_date >= $2::date AND r.start_date <= $3::date
        ORDER BY r.start_date, r.start_time NULLS FIRST`,
      [user.id, from.slice(0, 10), to.slice(0, 10)],
    ),
    db.query<{ n: number }>('SELECT count(*)::int AS n FROM schedules'),
  ]);

  const link = `View in Toretto: ${config.appUrl}/my-schedule`;
  const manySchedules = (scheduleCount.rows[0]?.n ?? 0) > 1;
  const shiftEvent = (s: ShiftView): IcsEvent => ({
    uid: `${s.id}@toretto`,
    summary: s.label ? `${s.label.name} shift` : 'Shift',
    description: [
      manySchedules && `Schedule: ${s.scheduleName}`,
      s.notes && `Notes: ${s.notes}`,
      link,
    ]
      .filter(Boolean)
      .join('\n'),
    when: { start: s.startTime, end: s.endTime },
  });
  return icsCalendar({
    name: `${settings.orgName} shifts`,
    description: 'Your shifts and approved time off, from Toretto.',
    now,
    events: [
      ...shifts.map(shiftEvent),
      ...timeOff.rows.map((t): IcsEvent => ({
        uid: `time-off-${t.id}@toretto`,
        summary: `Time off: ${t.type}`,
        description: [t.note && `Note: ${t.note}`, link].filter(Boolean).join('\n'),
        when: isPartialDay(t)
          ? { start: t.startTime, end: t.endTime }
          : { firstDay: t.startDate, lastDay: t.endDate },
        free: true,
      })),
    ],
  });
}
