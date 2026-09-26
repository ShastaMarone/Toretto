import type {
  AdminOverview,
  AuditEntry,
  Bootstrap,
  Label,
  NotificationEntry,
  OrgSettings,
  Person,
  ScheduleDetail,
  ScheduleSummary,
  ShiftView,
  Team,
  TeamSchedule,
  Tier,
  TimeOffRequest,
  TimeOffType,
} from '@shared/types';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from './client';

export const keys = {
  bootstrap: ['bootstrap'] as const,
  tiers: ['tiers'] as const,
  teams: ['teams'] as const,
  labels: ['labels'] as const,
  timeOffTypes: (all: boolean) => ['time-off-types', all] as const,
  people: ['people'] as const,
  schedules: ['schedules'] as const,
  schedule: (id: string) => ['schedule', id] as const,
  myShifts: (from: string, to: string) => ['my-shifts', from, to] as const,
  myTimeOff: ['my-time-off'] as const,
  team: (from: string, to: string, tierId: string, teamId: string) =>
    ['team', from, to, tierId, teamId] as const,
  timeOff: (status: string) => ['time-off', status] as const,
  overview: ['overview'] as const,
  activity: ['activity'] as const,
  notifications: (status: string) => ['notifications', status] as const,
  settings: ['settings'] as const,
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
export const useSchedule = (id: string) =>
  useQuery({
    queryKey: keys.schedule(id),
    queryFn: () => api.get<ScheduleDetail>(`/schedules/${id}`),
  });
export const useMyShifts = (from: string, to: string) =>
  useQuery({
    queryKey: keys.myShifts(from, to),
    queryFn: () => api.get<ShiftView[]>(`/my/shifts${qs({ from, to })}`),
  });
export const useMyTimeOff = () =>
  useQuery({ queryKey: keys.myTimeOff, queryFn: () => api.get<TimeOffRequest[]>('/my/time-off') });
export const useTeamSchedule = (from: string, to: string, tierId: string, teamId: string) =>
  useQuery({
    queryKey: keys.team(from, to, tierId, teamId),
    queryFn: () => api.get<TeamSchedule>(`/team/schedule${qs({ from, to, tierId, teamId })}`),
    placeholderData: (previous) => previous,
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
