import type { Role, TimeFormat } from '@shared/types';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  tierId: string | null;
  teamId: string | null;
  timezone: string | null;
  timeFormat: TimeFormat | null;
  hasPassword: boolean;
  notifyTimeOff: boolean;
  notifyConfirmations: boolean;
}

/** SQL select list producing an AuthUser from `users u`. */
export const AUTH_USER_COLUMNS = `
  u.id, u.name, u.email, u.role, u.tier_id AS "tierId", u.team_id AS "teamId",
  u.timezone, u.time_format AS "timeFormat", (u.password_hash IS NOT NULL) AS "hasPassword",
  u.notify_time_off AS "notifyTimeOff", u.notify_confirmations AS "notifyConfirmations"`;
