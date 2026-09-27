import type {
  AdminOverview,
  AuditEntry,
  Bootstrap,
  CalendarFeed,
  Label,
  NotificationEntry,
  OpenShift,
  OrgSettings,
  Person,
  ScheduleRange,
  ScheduleSummary,
  ShiftSwap,
  ShiftView,
  Team,
  TeamSchedule,
  Tier,
  TimeOffRequest,
  TimeOffType,
} from '@shared/types';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, qs } from './client';

export const keys = {
  bootstrap: ['bootstrap'] as const,
  tiers: ['tiers'] as const,
  teams: ['teams'] as const,
  labels: ['labels'] as const,
  timeOffTypes: (all: boolean) => ['time-off-types', all] as const,
  people: ['people'] as const,
  schedules: ['schedules'] as const,
  schedule: (id: string, from: string, to: string) => ['schedule', id, from, to] as const,
  myShifts: (from: string, to: string) => ['my-shifts', from, to] as const,
  myTimeOff: ['my-time-off'] as const,
  team: (from: string, to: string) => ['team', from, to] as const,
  timeOff: (status: string) => ['time-off', status] as const,
  overview: ['overview'] as const,
  activity: ['activity'] as const,
  notifications: (status: string) => ['notifications', status] as const,
  settings: ['settings'] as const,
  calendarFeed: ['calendar-feed'] as const,
  mySwaps: ['my-swaps'] as const,
  swaps: ['swaps'] as const,
  myOpenShifts: ['my-open-shifts'] as const,
  openShifts: ['open-shifts'] as const,
};

export const useBootstrap = () =>
  useQuery({
    queryKey: keys.bootstrap,
    queryFn: () => api.get<Bootstrap>('/bootstrap'),
    staleTime: 5 * 60_000,
  });

export const useTiers = () =>
  useQuery({ queryKey: keys.tiers, queryFn: () => api.get<Tier[]>('/tiers') });
export const useTeams = () =>
  useQuery({ queryKey: keys.teams, queryFn: () => api.get<Team[]>('/teams') });
export const useLabels = () =>
  useQuery({ queryKey: keys.labels, queryFn: () => api.get<Label[]>('/labels') });
export const useTimeOffTypes = (all = false) =>
  useQuery({
    queryKey: keys.timeOffTypes(all),
    queryFn: () => api.get<TimeOffType[]>(`/time-off-types${all ? '?all=1' : ''}`),
  });
export const usePeople = () =>
  useQuery({ queryKey: keys.people, queryFn: () => api.get<Person[]>('/users') });
export const useSchedules = () =>
  useQuery({ queryKey: keys.schedules, queryFn: () => api.get<ScheduleSummary[]>('/schedules') });
export const useScheduleRange = (id: string, from: string, to: string) =>
  useQuery({
    queryKey: keys.schedule(id, from, to),
    queryFn: () => api.get<ScheduleRange>(`/schedules/${id}${qs({ from, to })}`),
    enabled: Boolean(id),
    // Keep showing the previous week while the next one loads.
    placeholderData: keepPreviousData,
  });
export const useMyShifts = (from: string, to: string) =>
  useQuery({
    queryKey: keys.myShifts(from, to),
    queryFn: () => api.get<ShiftView[]>(`/my/shifts${qs({ from, to })}`),
  });
export const useMyTimeOff = () =>
  useQuery({ queryKey: keys.myTimeOff, queryFn: () => api.get<TimeOffRequest[]>('/my/time-off') });
export const useTeamSchedule = (from: string, to: string) =>
  useQuery({
    queryKey: keys.team(from, to),
    queryFn: () => api.get<TeamSchedule>(`/team/schedule${qs({ from, to })}`),
    placeholderData: keepPreviousData,
  });
export const useTimeOffRequests = (status: string) =>
  useQuery({
    queryKey: keys.timeOff(status),
    queryFn: () => api.get<TimeOffRequest[]>(`/time-off${qs({ status })}`),
  });
export const useOverview = () =>
  useQuery({ queryKey: keys.overview, queryFn: () => api.get<AdminOverview>('/admin/overview') });
export const useActivity = () =>
  useQuery({
    queryKey: keys.activity,
    queryFn: () => api.get<AuditEntry[]>('/admin/activity?limit=100'),
  });
export const useNotifications = (status: string) =>
  useQuery({
    queryKey: keys.notifications(status),
    queryFn: () => api.get<NotificationEntry[]>(`/admin/notifications${qs({ status })}`),
  });
export const useSettings = () =>
  useQuery({ queryKey: keys.settings, queryFn: () => api.get<OrgSettings>('/admin/settings') });
export const useCalendarFeed = () =>
  useQuery({ queryKey: keys.calendarFeed, queryFn: () => api.get<CalendarFeed>('/me/calendar') });
export const useMySwaps = () =>
  useQuery({ queryKey: keys.mySwaps, queryFn: () => api.get<ShiftSwap[]>('/my/swaps') });
export const useSwaps = () =>
  useQuery({ queryKey: keys.swaps, queryFn: () => api.get<ShiftSwap[]>('/swaps') });
export const useMyOpenShifts = () =>
  useQuery({ queryKey: keys.myOpenShifts, queryFn: () => api.get<OpenShift[]>('/my/open-shifts') });
export const useOpenShifts = () =>
  useQuery({ queryKey: keys.openShifts, queryFn: () => api.get<OpenShift[]>('/open-shifts') });
