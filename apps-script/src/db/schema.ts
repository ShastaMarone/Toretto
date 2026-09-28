// The Google Sheet's tabs, one per table, mirroring the Postgres schema in
// server/migrations (minus sessions and sign-in tokens: Google signs people in).
// Every cell is plain text; each column's type says how to read it back.

export type ColumnType = 'text' | 'number' | 'boolean' | 'json' | 'time';

export interface TableDef<T> {
  /** The tab's name. */
  name: string;
  /** Columns, in the order they're first created. */
  columns: { [K in keyof T]: ColumnType };
  /** Values for columns a new row doesn't set. */
  defaults?: Partial<T>;
}

export interface OrgSettingsRow {
  id: string;
  orgName: string;
  timezone: string;
  weekStartsOn: number;
  reminderHours: number;
  selfSignup: boolean;
  allowedDomains: string[];
  holidayRegion: string;
  timeFormat: string;
  emailRetentionDays: number | null;
  overtimeDailyHours: number | null;
  overtimeWeeklyHours: number | null;
  updatedAt: string;
}

export interface TierRow {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface TeamRow {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  tierId: string | null;
  teamId: string | null;
  timezone: string | null;
  timeFormat: '12h' | '24h' | null;
  /** When they first opened the app (they've "joined"). */
  emailVerifiedAt: string | null;
  invitedAt: string | null;
  invitedBy: string | null;
  deactivatedAt: string | null;
  lastLoginAt: string | null;
  notifyTimeOff: boolean;
  notifyConfirmations: boolean;
  notifySwaps: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LabelRow {
  id: string;
  tierId: string | null;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRow {
  id: string;
  name: string;
  isDefault: boolean;
  publishedAt: string | null;
  publishedBy: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ShiftRow {
  id: string;
  scheduleId: string;
  userId: string;
  labelId: string | null;
  startTime: string;
  endTime: string;
  notes: string | null;
  status: 'pending' | 'confirmed';
  confirmedAt: string | null;
  publishedAt: string | null;
  publishedUserId: string | null;
  publishedLabelId: string | null;
  publishedStartTime: string | null;
  publishedEndTime: string | null;
  publishedNotes: string | null;
  deletedAt: string | null;
  reminderSentAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TimeOffTypeRow {
  id: string;
  name: string;
  color: string;
  paid: boolean;
  sortOrder: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TimeOffRow {
  id: string;
  userId: string;
  typeId: string;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  note: string | null;
  status: 'pending' | 'approved' | 'denied' | 'cancelled';
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationRow {
  id: string;
  userId: string | null;
  kind: string;
  toEmail: string;
  subject: string;
  html: string;
  text: string;
  scheduleId: string | null;
  shiftIds: string[];
  status: 'queued' | 'sending' | 'sent' | 'failed';
  attempts: number;
  lastError: string | null;
  runAfter: string;
  lockedAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface AuditRow {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface SwapRow {
  id: string;
  shiftId: string;
  requesterId: string;
  recipientId: string;
  returnShiftId: string | null;
  note: string | null;
  status:
    | 'pending'
    | 'accepted'
    | 'approved'
    | 'declined'
    | 'denied'
    | 'cancelled'
    | 'expired'
    | 'changed';
  respondedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  shiftVersion: string | null;
  returnVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OpenShiftRow {
  id: string;
  scheduleId: string;
  tierId: string;
  labelId: string | null;
  startTime: string;
  endTime: string;
  notes: string | null;
  status: 'open' | 'claimed' | 'filled' | 'cancelled' | 'expired';
  claimedBy: string | null;
  claimedAt: string | null;
  declinedIds: string[];
  reviewedBy: string | null;
  reviewedAt: string | null;
  shiftId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export const ORG_SETTINGS: TableDef<OrgSettingsRow> = {
  name: 'org_settings',
  columns: {
    id: 'text',
    orgName: 'text',
    timezone: 'text',
    weekStartsOn: 'number',
    reminderHours: 'number',
    selfSignup: 'boolean',
    allowedDomains: 'json',
    holidayRegion: 'text',
    timeFormat: 'text',
    emailRetentionDays: 'number',
    overtimeDailyHours: 'number',
    overtimeWeeklyHours: 'number',
    updatedAt: 'time',
  },
};

export const TIERS: TableDef<TierRow> = {
  name: 'tiers',
  columns: {
    id: 'text',
    name: 'text',
    color: 'text',
    sortOrder: 'number',
    createdAt: 'time',
    updatedAt: 'time',
  },
  defaults: { sortOrder: 0 },
};

export const TEAMS: TableDef<TeamRow> = {
  name: 'teams',
  columns: { id: 'text', name: 'text', createdAt: 'time', updatedAt: 'time' },
};

export const USERS: TableDef<UserRow> = {
  name: 'users',
  columns: {
    id: 'text',
    name: 'text',
    email: 'text',
    role: 'text',
    tierId: 'text',
    teamId: 'text',
    timezone: 'text',
    timeFormat: 'text',
    emailVerifiedAt: 'time',
    invitedAt: 'time',
    invitedBy: 'text',
    deactivatedAt: 'time',
    lastLoginAt: 'time',
    notifyTimeOff: 'boolean',
    notifyConfirmations: 'boolean',
    notifySwaps: 'boolean',
    createdAt: 'time',
    updatedAt: 'time',
  },
  defaults: {
    role: 'member',
    tierId: null,
    teamId: null,
    timezone: null,
    timeFormat: null,
    emailVerifiedAt: null,
    invitedAt: null,
    invitedBy: null,
    deactivatedAt: null,
    lastLoginAt: null,
    notifyTimeOff: true,
    notifyConfirmations: true,
    notifySwaps: true,
  },
};

export const LABELS: TableDef<LabelRow> = {
  name: 'labels',
  columns: {
    id: 'text',
    tierId: 'text',
    name: 'text',
    color: 'text',
    createdAt: 'time',
    updatedAt: 'time',
  },
  defaults: { tierId: null },
};

export const SCHEDULES: TableDef<ScheduleRow> = {
  name: 'schedules',
  columns: {
    id: 'text',
    name: 'text',
    isDefault: 'boolean',
    publishedAt: 'time',
    publishedBy: 'text',
    createdBy: 'text',
    createdAt: 'time',
    updatedAt: 'time',
  },
  defaults: { isDefault: false, publishedAt: null, publishedBy: null, createdBy: null },
};

export const SHIFTS: TableDef<ShiftRow> = {
  name: 'shifts',
  columns: {
    id: 'text',
    scheduleId: 'text',
    userId: 'text',
    labelId: 'text',
    startTime: 'time',
    endTime: 'time',
    notes: 'text',
    status: 'text',
    confirmedAt: 'time',
    publishedAt: 'time',
    publishedUserId: 'text',
    publishedLabelId: 'text',
    publishedStartTime: 'time',
    publishedEndTime: 'time',
    publishedNotes: 'text',
    deletedAt: 'time',
    reminderSentAt: 'time',
    createdBy: 'text',
    createdAt: 'time',
    updatedAt: 'time',
  },
  defaults: {
    labelId: null,
    notes: null,
    status: 'pending',
    confirmedAt: null,
    publishedAt: null,
    publishedUserId: null,
    publishedLabelId: null,
    publishedStartTime: null,
    publishedEndTime: null,
    publishedNotes: null,
    deletedAt: null,
    reminderSentAt: null,
    createdBy: null,
  },
};

export const TIME_OFF_TYPES: TableDef<TimeOffTypeRow> = {
  name: 'time_off_types',
  columns: {
    id: 'text',
    name: 'text',
    color: 'text',
    paid: 'boolean',
    sortOrder: 'number',
    archivedAt: 'time',
    createdAt: 'time',
    updatedAt: 'time',
  },
  defaults: { paid: true, sortOrder: 0, archivedAt: null },
};

export const TIME_OFF: TableDef<TimeOffRow> = {
  name: 'time_off_requests',
  columns: {
    id: 'text',
    userId: 'text',
    typeId: 'text',
    startDate: 'text',
    endDate: 'text',
    startTime: 'time',
    endTime: 'time',
    note: 'text',
    status: 'text',
    reviewedBy: 'text',
    reviewedAt: 'time',
    reviewNote: 'text',
    createdBy: 'text',
    createdAt: 'time',
    updatedAt: 'time',
  },
  defaults: {
    startTime: null,
    endTime: null,
    note: null,
    status: 'pending',
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    createdBy: null,
  },
};

export const NOTIFICATIONS: TableDef<NotificationRow> = {
  name: 'email_log',
  columns: {
    id: 'text',
    userId: 'text',
    kind: 'text',
    toEmail: 'text',
    subject: 'text',
    html: 'text',
    text: 'text',
    scheduleId: 'text',
    shiftIds: 'json',
    status: 'text',
    attempts: 'number',
    lastError: 'text',
    runAfter: 'time',
    lockedAt: 'time',
    sentAt: 'time',
    createdAt: 'time',
  },
  defaults: {
    userId: null,
    scheduleId: null,
    shiftIds: [],
    status: 'queued',
    attempts: 0,
    lastError: null,
    lockedAt: null,
    sentAt: null,
  },
};

export const AUDIT: TableDef<AuditRow> = {
  name: 'audit_log',
  columns: {
    id: 'text',
    actorId: 'text',
    action: 'text',
    entityType: 'text',
    entityId: 'text',
    details: 'json',
    createdAt: 'time',
  },
  defaults: { actorId: null, entityId: null, details: {} },
};

export const SWAPS: TableDef<SwapRow> = {
  name: 'shift_swaps',
  columns: {
    id: 'text',
    shiftId: 'text',
    requesterId: 'text',
    recipientId: 'text',
    returnShiftId: 'text',
    note: 'text',
    status: 'text',
    respondedAt: 'time',
    reviewedBy: 'text',
    reviewedAt: 'time',
    reviewNote: 'text',
    shiftVersion: 'time',
    returnVersion: 'time',
    createdAt: 'time',
    updatedAt: 'time',
  },
  defaults: {
    returnShiftId: null,
    note: null,
    status: 'pending',
    respondedAt: null,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    shiftVersion: null,
    returnVersion: null,
  },
};

export const OPEN_SHIFTS: TableDef<OpenShiftRow> = {
  name: 'open_shifts',
  columns: {
    id: 'text',
    scheduleId: 'text',
    tierId: 'text',
    labelId: 'text',
    startTime: 'time',
    endTime: 'time',
    notes: 'text',
    status: 'text',
    claimedBy: 'text',
    claimedAt: 'time',
    declinedIds: 'json',
    reviewedBy: 'text',
    reviewedAt: 'time',
    shiftId: 'text',
    createdBy: 'text',
    createdAt: 'time',
    updatedAt: 'time',
  },
  defaults: {
    labelId: null,
    notes: null,
    status: 'open',
    claimedBy: null,
    claimedAt: null,
    declinedIds: [],
    reviewedBy: null,
    reviewedAt: null,
    shiftId: null,
    createdBy: null,
  },
};

/** Every tab, in the order they're created in a new Sheet. */
export const TABLES = [
  ORG_SETTINGS,
  USERS,
  TIERS,
  TEAMS,
  LABELS,
  SCHEDULES,
  SHIFTS,
  TIME_OFF_TYPES,
  TIME_OFF,
  SWAPS,
  OPEN_SHIFTS,
  AUDIT,
  NOTIFICATIONS,
] as const;
