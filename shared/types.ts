// API contract shared by the server and the web app.
// Timestamps are ISO-8601 strings in UTC; calendar days are 'YYYY-MM-DD'.
import type { HolidayRegion } from './holidays';
import type { TimeFormat } from './time';

export type { HolidayRegion } from './holidays';
export type { TimeFormat } from './time';

export type Role = 'admin' | 'member';
export type UserStatus = 'invited' | 'active' | 'deactivated';
export type ShiftStatus = 'pending' | 'confirmed';
/** How a shift's working copy differs from what the team currently sees. */
export type ChangeState = 'new' | 'updated' | 'unchanged' | 'removed';
export type TimeOffStatus = 'pending' | 'approved' | 'denied' | 'cancelled';
export type NotificationStatus = 'queued' | 'sending' | 'sent' | 'failed';
export type WeekStart = 0 | 1;

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
    details?: unknown;
  };
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  tierId: string | null;
  teamId: string | null;
  /** Personal time zone; null means the organization's. */
  timezone: string | null;
  /** Personal 12/24-hour choice; null means the organization's. */
  timeFormat: TimeFormat | null;
  hasPassword: boolean;
  /** Admins: email me when someone requests time off. */
  notifyTimeOff: boolean;
  /** Admins: email me when someone confirms shifts. */
  notifyConfirmations: boolean;
  /** Admins: email me about shift swaps and open shifts to approve. */
  notifySwaps: boolean;
}

/** Someone's calendar feed link, or null while it's turned off. */
export interface CalendarFeed {
  url: string | null;
}

export interface OrgInfo {
  name: string;
  timezone: string;
  weekStartsOn: WeekStart;
  /** Statutory holidays shown on calendars. */
  holidayRegion: HolidayRegion;
  /** Default 12/24-hour format for everyone (and emails). */
  timeFormat: TimeFormat;
}

export interface Bootstrap {
  user: SessionUser | null;
  org: OrgInfo;
  setupRequired: boolean;
  selfSignup: boolean;
  allowedDomains: string[];
  devMailbox: boolean;
  /** An email provider is configured (otherwise emails only go to the server log). */
  emailConfigured: boolean;
}

export interface OrgSettings {
  orgName: string;
  timezone: string;
  weekStartsOn: WeekStart;
  reminderHours: number;
  selfSignup: boolean;
  allowedDomains: string[];
  holidayRegion: HolidayRegion;
  timeFormat: TimeFormat;
  /** Days the email log keeps sent and failed emails; null keeps them forever. */
  emailRetentionDays: number | null;
  /** Overtime past this many hours in a day (null: no daily limit). */
  overtimeDailyHours: number | null;
  /** Overtime past this many hours in a week (null: no weekly limit). */
  overtimeWeeklyHours: number | null;
}

export interface Tier {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  memberCount: number;
}

export interface Team {
  id: string;
  name: string;
  memberCount: number;
}

export interface Label {
  id: string;
  /** null = available to every tier */
  tierId: string | null;
  name: string;
  color: string;
  shiftCount: number;
}

export interface TimeOffType {
  id: string;
  name: string;
  color: string;
  paid: boolean;
  archived: boolean;
  sortOrder: number;
}

export interface Person {
  id: string;
  name: string;
  email: string;
  role: Role;
  tierId: string | null;
  teamId: string | null;
  timezone: string | null;
  status: UserStatus;
  lastLoginAt: string | null;
  createdAt: string;
  shiftCount: number;
}

/** Minimal person info used for schedule grid rows. */
export interface PersonRow {
  id: string;
  name: string;
  tierId: string | null;
  teamId: string | null;
  active: boolean;
}

/**
 * A schedule is an open-ended calendar covering every tier. There's always a
 * default one; admins can add more for separate rosters.
 */
export interface ScheduleSummary {
  id: string;
  name: string;
  isDefault: boolean;
  /** When changes were last published. */
  publishedAt: string | null;
  publishedByName: string | null;
  /** Shifts added, changed or removed since they were last published (any date). */
  pendingChanges: number;
  /** First and last day (organization calendar) with unpublished changes. */
  firstChangeDate: string | null;
  lastChangeDate: string | null;
  createdAt: string;
}

export interface ShiftSnapshot {
  userId: string;
  labelId: string | null;
  startTime: string;
  endTime: string;
  notes: string | null;
}

/** A shift as the schedule builder sees it (working copy + published snapshot). */
export interface BuilderShift extends ShiftSnapshot {
  id: string;
  scheduleId: string;
  status: ShiftStatus;
  confirmedAt: string | null;
  changeState: ChangeState;
  published: ShiftSnapshot | null;
}

export interface TimeOffEntry {
  id: string;
  userId: string;
  startDate: string;
  endDate: string;
  /** Only for part of a day. */
  startTime: string | null;
  endTime: string | null;
  status: 'pending' | 'approved';
  /** Hidden (null) when a team member looks at someone else's time off. */
  typeName: string | null;
  typeColor: string | null;
}

export interface ChangeCounts {
  added: number;
  updated: number;
  removed: number;
  total: number;
}

/** Everything the schedule builder shows for a date range. */
export interface ScheduleRange {
  schedule: ScheduleSummary;
  from: string;
  to: string;
  /** Working copies that start in the range. */
  shifts: BuilderShift[];
  /**
   * Published shifts in the range that the team still sees but that are going
   * away on the next publish: deleted, or moved outside the range.
   */
  removedShifts: BuilderShift[];
  people: PersonRow[];
  labels: Label[];
  timeOff: TimeOffEntry[];
  /** Unpublished changes in the range. */
  changes: ChangeCounts;
}

export interface PublishResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  emailsQueued: number;
}

export interface CopyResult {
  copied: number;
  skipped: number;
}

/** A published shift as team members see it. */
export interface ShiftView {
  id: string;
  scheduleId: string;
  userId: string;
  startTime: string;
  endTime: string;
  notes: string | null;
  status: ShiftStatus;
  confirmedAt: string | null;
  label: { id: string; name: string; color: string } | null;
  /** The person's tier (null if they don't have one). */
  tier: { id: string; name: string; color: string } | null;
  scheduleName: string;
}

/** Adding a repeating shift: one shift per day, minus the days skipped. */
export interface RepeatResult {
  created: number;
  skipped: {
    startTime: string;
    endTime: string;
    reason: 'overlap' | 'time_off';
    /** "Vacation", "already has a shift", ... */
    detail: string;
  }[];
}

export interface TeamSchedule {
  people: PersonRow[];
  shifts: ShiftView[];
  timeOff: TimeOffEntry[];
  schedules: { id: string; name: string }[];
}

export interface TimeOffRequest {
  id: string;
  userId: string;
  userName: string;
  tierId: string | null;
  type: { id: string; name: string; color: string; paid: boolean };
  startDate: string;
  endDate: string;
  /** Only for part of a day. */
  startTime: string | null;
  endTime: string | null;
  note: string | null;
  status: TimeOffStatus;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewNote: string | null;
  createdAt: string;
  /** Admin view only: scheduled shifts that overlap the requested days. */
  conflicts?: number;
}

export type SwapStatus =
  /** Waiting for the coworker. */
  | 'pending'
  /** The coworker agreed; waiting for an admin. */
  | 'accepted'
  | 'approved'
  /** The coworker said no. */
  | 'declined'
  /** An admin said no. */
  | 'denied'
  | 'cancelled'
  /** A shift started before it was settled. */
  | 'expired'
  /** A shift was republished differently (or reassigned) before it was settled. */
  | 'changed';

/** A shift in a swap, as published. */
export interface SwapShift {
  id: string;
  startTime: string;
  endTime: string;
  labelName: string | null;
  /** The label's color, else the owner's tier's. */
  color: string | null;
  scheduleName: string;
}

export interface ShiftSwap {
  id: string;
  status: SwapStatus;
  requester: { id: string; name: string };
  recipient: { id: string; name: string };
  /** The requester's shift, offered to the recipient. */
  shift: SwapShift;
  /** A trade: the recipient's shift the requester takes in return. */
  returnShift: SwapShift | null;
  note: string | null;
  reviewNote: string | null;
  reviewedByName: string | null;
  createdAt: string;
  respondedAt: string | null;
  reviewedAt: string | null;
}

/** A coworker who could take a shift. */
export interface SwapOption {
  id: string;
  name: string;
  /** Why they can't take it ("Working then", "Off then"), or null if they can. */
  busy: string | null;
  /** Their upcoming shifts that could be traded for it (you're free then). */
  shifts: SwapShift[];
}

export type OpenShiftStatus =
  | 'open'
  /** Someone picked it up; waiting for an admin. */
  | 'claimed'
  /** Approved: it's someone's shift now. */
  | 'filled'
  | 'cancelled'
  /** It started while still open. */
  | 'expired';

/** A shift nobody has yet, for anyone in its tier to pick up. */
export interface OpenShift {
  id: string;
  status: OpenShiftStatus;
  scheduleId: string;
  scheduleName: string;
  tier: { id: string; name: string; color: string };
  label: { id: string; name: string; color: string } | null;
  startTime: string;
  endTime: string;
  notes: string | null;
  /** Who picked it up (or got it). */
  claimedBy: { id: string; name: string } | null;
  claimedAt: string | null;
  reviewedByName: string | null;
  createdAt: string;
  /** For team members: why you can't pick it up now, or null if you can. */
  busy?: string | null;
}

export interface AuditEntry {
  id: number;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface NotificationEntry {
  id: string;
  kind: string;
  toEmail: string;
  userName: string | null;
  subject: string;
  status: NotificationStatus;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface UnconfirmedShift extends ShiftView {
  userName: string;
}

export interface WeekConfirmations {
  startDate: string;
  endDate: string;
  /** Published shifts that week. */
  total: number;
  confirmed: number;
}

export interface AdminOverview {
  pendingTimeOff: number;
  peopleWithoutTier: number;
  invitedPeople: number;
  schedules: ScheduleSummary[];
  /** This week and the next three. */
  weeks: WeekConfirmations[];
  unconfirmedSoon: UnconfirmedShift[];
  recentActivity: AuditEntry[];
  failedEmails: number;
}

export interface MailboxMessage {
  id: string;
  kind: string;
  toEmail: string;
  subject: string;
  html: string;
  text: string;
  status: NotificationStatus;
  createdAt: string;
}
