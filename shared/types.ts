// API contract shared by the server and the web app.
// Timestamps are ISO-8601 strings in UTC; calendar days are 'YYYY-MM-DD'.

export type Role = 'admin' | 'member';
export type UserStatus = 'invited' | 'active' | 'deactivated';
export type ScheduleStatus = 'draft' | 'published';
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
  hasPassword: boolean;
}

export interface OrgInfo {
  name: string;
  timezone: string;
  weekStartsOn: WeekStart;
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

export interface ScheduleSummary {
  id: string;
  tierId: string;
  tierName: string;
  tierColor: string;
  name: string | null;
  startDate: string;
  endDate: string;
  status: ScheduleStatus;
  publishedAt: string | null;
  publishedByName: string | null;
  shiftCount: number;
  confirmedCount: number;
  pendingCount: number;
  /** Shifts added, changed or removed since the last publish. */
  pendingChanges: number;
  updatedAt: string;
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

export interface ScheduleDetail {
  schedule: ScheduleSummary;
  shifts: BuilderShift[];
  /** Published shifts deleted in the working copy; removed on next publish. */
  removedShifts: BuilderShift[];
  members: PersonRow[];
  labels: Label[];
  timeOff: TimeOffEntry[];
  changes: ChangeCounts;
}

export interface PublishResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  emailsQueued: number;
}

export interface CreateScheduleResult {
  schedule: ScheduleSummary;
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
  tier: { id: string; name: string; color: string };
}

export interface TeamSchedule {
  people: PersonRow[];
  shifts: ShiftView[];
  timeOff: TimeOffEntry[];
}

export interface TimeOffRequest {
  id: string;
  userId: string;
  userName: string;
  tierId: string | null;
  type: { id: string; name: string; color: string; paid: boolean };
  startDate: string;
  endDate: string;
  note: string | null;
  status: TimeOffStatus;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewNote: string | null;
  createdAt: string;
  /** Admin view only: scheduled shifts that overlap the requested days. */
  conflicts?: number;
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

export interface AdminOverview {
  pendingTimeOff: number;
  peopleWithoutTier: number;
  invitedPeople: number;
  drafts: ScheduleSummary[];
  withChanges: ScheduleSummary[];
  upcoming: ScheduleSummary[];
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
