import type { OrgSettings, PersonRow, ShiftView, TimeOffEntry } from '@shared/types';
import type { AuthUser } from '../../server/src/auth/types';
import {
  AUDIT,
  CALENDAR_EVENTS,
  LABELS,
  NOTIFICATIONS,
  OPEN_SHIFTS,
  ORG_SETTINGS,
  SCHEDULES,
  SHIFTS,
  SWAPS,
  TEAMS,
  TIERS,
  TIME_OFF,
  TIME_OFF_TYPES,
  USERS,
  type OrgSettingsRow,
  type ShiftRow,
  type UserRow,
} from './db/schema';
import type { Db } from './db/store';

export { timeFormatFor, zoneFor } from '../../server/src/services/settings';

/** One request (or one run of a background job). */
export interface Ctx {
  db: Db;
  /** The request's clock: every change it makes is stamped with this. */
  now: string;
  /** The signed-in person (active and on the People list), for routes that need one. */
  user: AuthUser | null;
  /** The Google account using the app ('' in background jobs). */
  email: string;
  /** The web app's address, for links in emails. */
  appUrl: string;
  /** Emails queued: the page asks for them to go out right away. */
  queued: number;
}

export const tables = (db: Db) => ({
  settings: db.table(ORG_SETTINGS),
  users: db.table(USERS),
  tiers: db.table(TIERS),
  teams: db.table(TEAMS),
  labels: db.table(LABELS),
  schedules: db.table(SCHEDULES),
  shifts: db.table(SHIFTS),
  timeOffTypes: db.table(TIME_OFF_TYPES),
  timeOff: db.table(TIME_OFF),
  swaps: db.table(SWAPS),
  openShifts: db.table(OPEN_SHIFTS),
  audit: db.table(AUDIT),
  notifications: db.table(NOTIFICATIONS),
  calendarEvents: db.table(CALENDAR_EVENTS),
});

export const ORG_ID = 'org';

export const DEFAULT_SETTINGS: Omit<OrgSettingsRow, 'id' | 'updatedAt'> = {
  orgName: 'My Team',
  timezone: 'America/Toronto',
  weekStartsOn: 1,
  reminderHours: 24,
  selfSignup: false,
  allowedDomains: [],
  holidayRegion: 'CA',
  timeFormat: '12h',
  emailRetentionDays: 90,
  overtimeDailyHours: 8,
  overtimeWeeklyHours: 40,
};

export function getSettings(db: Db): OrgSettings {
  const row = tables(db).settings.get(ORG_ID);
  const s = { ...DEFAULT_SETTINGS, ...row };
  return {
    orgName: s.orgName,
    timezone: s.timezone,
    weekStartsOn: s.weekStartsOn === 0 ? 0 : 1,
    reminderHours: s.reminderHours,
    selfSignup: s.selfSignup,
    allowedDomains: s.allowedDomains ?? [],
    holidayRegion: s.holidayRegion as OrgSettings['holidayRegion'],
    timeFormat: s.timeFormat === '24h' ? '24h' : '12h',
    emailRetentionDays: s.emailRetentionDays,
    overtimeDailyHours: s.overtimeDailyHours,
    overtimeWeeklyHours: s.overtimeWeeklyHours,
  };
}

export function authUser(u: UserRow): AuthUser {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    tierId: u.tierId,
    teamId: u.teamId,
    timezone: u.timezone,
    timeFormat: u.timeFormat,
    hasPassword: false,
    notifyTimeOff: u.notifyTimeOff,
    notifyConfirmations: u.notifyConfirmations,
    notifySwaps: u.notifySwaps,
    calendarSync: u.calendarSync,
  };
}

// Audit ids are numbers (the API's AuditEntry.id), increasing with time.
let auditSeq = 0;

export function audit(
  ctx: Ctx,
  actorId: string | null,
  action: string,
  entity: { type: string; id?: string | null },
  details: Record<string, unknown> = {},
): void {
  const id = String(Date.parse(ctx.now) * 1000 + (auditSeq++ % 1000));
  tables(ctx.db).audit.insert({
    id,
    actorId,
    action,
    entityType: entity.type,
    entityId: entity.id ?? null,
    details,
    createdAt: ctx.now,
  });
}

/** Instants in the stored form: UTC ISO with milliseconds, so they compare as text too. */
export const iso = (value: string | number | Date) => new Date(value).toISOString();
export const ms = (value: string) => Date.parse(value);

/** Sort by name, ignoring case (Postgres `ORDER BY lower(name)`). */
export function byName<T extends { name: string }>(a: T, b: T): number {
  const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
  return x < y ? -1 : x > y ? 1 : 0;
}

export function compare(a: string | number | null, b: string | number | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

export function personRow(u: UserRow): PersonRow {
  return { id: u.id, name: u.name, tierId: u.tierId, teamId: u.teamId, active: !u.deactivatedAt };
}

/** A published shift as the team sees it, or null if it isn't published. */
export function shiftView(db: Db, s: ShiftRow): ShiftView | null {
  const t = tables(db);
  if (!s.publishedAt || !s.publishedUserId) return null;
  const person = t.users.get(s.publishedUserId);
  const schedule = t.schedules.get(s.scheduleId);
  if (!person || !schedule) return null;
  const label = t.labels.get(s.publishedLabelId);
  const tier = t.tiers.get(person.tierId);
  return {
    id: s.id,
    scheduleId: s.scheduleId,
    userId: s.publishedUserId,
    startTime: s.publishedStartTime!,
    endTime: s.publishedEndTime!,
    notes: s.publishedNotes,
    status: s.status,
    confirmedAt: s.confirmedAt,
    label: label ? { id: label.id, name: label.name, color: label.color } : null,
    tier: tier ? { id: tier.id, name: tier.name, color: tier.color } : null,
    scheduleName: schedule.name,
  };
}

/** Published shifts overlapping from..to, earliest first (optionally one person's). */
export function publishedShifts(
  db: Db,
  range: { from: string; to: string },
  userId?: string,
): ShiftView[] {
  const [from, to] = [ms(range.from), ms(range.to)];
  return tables(db)
    .shifts.where(
      (s) =>
        s.publishedAt !== null &&
        (!userId || s.publishedUserId === userId) &&
        ms(s.publishedStartTime!) < to &&
        ms(s.publishedEndTime!) > from,
    )
    .sort((a, b) => ms(a.publishedStartTime!) - ms(b.publishedStartTime!))
    .map((s) => shiftView(db, s))
    .filter((v): v is ShiftView => v !== null);
}

/** Time off (approved, or also pending) for these people touching startDate..endDate. */
export function timeOffEntries(
  db: Db,
  userIds: Set<string>,
  startDate: string,
  endDate: string,
  statuses: ('pending' | 'approved')[],
): TimeOffEntry[] {
  const t = tables(db);
  return t.timeOff
    .where(
      (r) =>
        userIds.has(r.userId) &&
        (statuses as string[]).includes(r.status) &&
        r.startDate <= endDate &&
        r.endDate >= startDate,
    )
    .sort(
      (a, b) =>
        compare(a.startDate, b.startDate) ||
        compare(a.startTime ? ms(a.startTime) : null, b.startTime ? ms(b.startTime) : null),
    )
    .map((r) => {
      const type = t.timeOffTypes.get(r.typeId);
      return {
        id: r.id,
        userId: r.userId,
        startDate: r.startDate,
        endDate: r.endDate,
        startTime: r.startTime,
        endTime: r.endTime,
        status: r.status as 'pending' | 'approved',
        typeName: type?.name ?? null,
        typeColor: type?.color ?? null,
      };
    });
}
