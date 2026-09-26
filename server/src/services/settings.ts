import type { OrgSettings, TimeFormat } from '@shared/types';
import type { Queryable } from '../db';

export async function getSettings(db: Queryable): Promise<OrgSettings> {
  const { rows } = await db.query<OrgSettings>(
    `SELECT org_name AS "orgName", timezone, week_starts_on AS "weekStartsOn",
            reminder_hours AS "reminderHours", self_signup AS "selfSignup",
            allowed_domains AS "allowedDomains", holiday_region AS "holidayRegion",
            time_format AS "timeFormat", email_retention_days AS "emailRetentionDays",
            overtime_daily_hours AS "overtimeDailyHours",
            overtime_weekly_hours AS "overtimeWeeklyHours"
       FROM org_settings WHERE id`,
  );
  return rows[0]!;
}

/** A person's effective time zone: their own, else the organization's. */
export function zoneFor(user: { timezone: string | null }, settings: OrgSettings): string {
  return user.timezone ?? settings.timezone;
}

/** A person's effective 12/24-hour format: their own, else the organization's. */
export function timeFormatFor(
  user: { timeFormat: TimeFormat | null },
  settings: OrgSettings,
): TimeFormat {
  return user.timeFormat ?? settings.timeFormat;
}
