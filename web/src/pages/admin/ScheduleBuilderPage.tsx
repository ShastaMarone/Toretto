import {
  addDays,
  dayRangeToUtc,
  diffDays,
  eachDay,
  formatDateRange,
  formatDay,
  formatHours,
  formatShiftWhen,
  formatTimestamp,
  localDate,
  moveShiftToDate,
  startOfWeek,
  todayIn,
  type ISODate,
} from '@shared/time';
import type {
  BuilderShift,
  CopyResult,
  PersonRow,
  PublishResult,
  RepeatResult,
  ScheduleRange,
  ScheduleSummary,
  Tier,
} from '@shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { AlarmClock, CopyPlus, Ellipsis, Plus, Send, Undo2 } from 'lucide-react';
import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { api } from '../../api/client';
import {
  keys,
  useScheduleRange,
  useOpenShifts,
  useSchedules,
  useSettings,
  useTeamSchedule,
  useTeams,
  useTiers,
} from '../../api/queries';
import { CalendarNav, TierFilter } from '../../components/schedule/CalendarBits';
import { DayTimeline, type TimelineBar } from '../../components/schedule/DayTimeline';
import { ScheduleAgenda } from '../../components/schedule/ScheduleAgenda';
import { ScheduleGrid } from '../../components/schedule/ScheduleGrid';
import { ScheduleSwitcher } from '../../components/schedule/ScheduleSwitcher';
import {
  ShiftDialog,
  type RepeatPayload,
  type ShiftDraft,
  type ShiftPayload,
} from '../../components/schedule/ShiftDialog';
import { ScheduleLegend, ShiftChip, TimeOffChip } from '../../components/schedule/ShiftChip';
import { Button } from '../../components/ui/Button';
import { Field, FormError, Input, Select } from '../../components/ui/Form';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import {
  Avatar,
  Badge,
  ErrorBlock,
  LoadingBlock,
  Menu,
  Spinner,
  Tabs,
} from '../../components/ui/Misc';
import { cx } from '../../lib/cx';
import { fieldErrors, formMessage } from '../../lib/forms';
import { useHolidays } from '../../lib/holidays';
import { overtimeIn, overtimeRules } from '../../lib/overtime';
import {
  draftFromShift,
  breakMinutesByUser,
  groupByTier,
  groupByUserDay,
  stepView,
  timeOffByUserDay,
  totalHours,
  withBreaks,
  viewRange,
  type CalendarView,
} from '../../lib/schedule';
import { useBootstrapData, useTimeFormat } from '../../lib/session';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { zoneLabel } from '../../lib/timezones';

type DialogState = { mode: 'create'; draft: ShiftDraft } | { mode: 'edit'; shift: BuilderShift };

const VIEW_KEY = 'toretto:builder-view';
/** Where the builder remembers which tiers are collapsed (shared by the Day, Week and Month views). */
const COLLAPSED_TIERS_KEY = 'toretto:builder-collapsed-tiers';
const VIEWS: { value: CalendarView; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: '2weeks', label: '2 weeks' },
  { value: 'month', label: 'Month' },
];

function savedView(): CalendarView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'day' || v === '2weeks' || v === 'month' ? v : 'week';
  } catch {
    return 'week';
  }
}

/** /admin/schedules — open the main schedule. */
export function SchedulesIndex() {
  const schedules = useSchedules();
  const { search } = useLocation();
  if (schedules.isError)
    return <ErrorBlock error={schedules.error} onRetry={() => void schedules.refetch()} />;
  const main = schedules.data?.find((s) => s.isDefault) ?? schedules.data?.[0];
  if (!main) return <LoadingBlock />;
  return <Navigate to={`/admin/schedules/${main.id}${search}`} replace />;
}

export default function ScheduleBuilderPage() {
  const { id = '' } = useParams();
  const { org } = useBootstrapData();
  const tz = org.timezone; // schedules are built in the organization's zone
  const today = todayIn(tz);
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') as CalendarView | null) ?? savedView();
  const date = params.get('date') ?? today;
  const tierFilter = params.get('tiers')?.split(',').filter(Boolean) ?? [];
  const teamFilter = params.get('team') ?? '';
  const range = viewRange(view, date, org.weekStartsOn);
  const query = useScheduleRange(id, range.from, range.to);
  const schedules = useSchedules();

  const update = (patch: Record<string, string | null>) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        for (const [k, v] of Object.entries(patch)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: true },
    );

  if (query.isError) return <ErrorBlock error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <LoadingBlock />;
  return (
    <Builder
      data={query.data}
      loading={query.isPlaceholderData}
      schedules={schedules.data ?? [query.data.schedule]}
      view={view}
      date={date}
      today={today}
      tz={tz}
      tierFilter={tierFilter}
      teamFilter={teamFilter}
      onView={(v) => {
        try {
          localStorage.setItem(VIEW_KEY, v);
        } catch {
          // Just not remembered.
        }
        update({ view: v });
      }}
      onDate={(d) => update({ date: d === today ? null : d })}
      onTiers={(ids) => update({ tiers: ids.join(',') || null })}
      onTeam={(t) => update({ team: t || null })}
    />
  );
}

function Builder({
  data,
  loading,
  schedules,
  view,
  date,
  today,
  tz,
  tierFilter,
  teamFilter,
  onView,
  onDate,
  onTiers,
  onTeam,
}: {
  data: ScheduleRange;
  loading: boolean;
  schedules: ScheduleSummary[];
  view: CalendarView;
  date: ISODate;
  today: ISODate;
  tz: string;
  tierFilter: string[];
  teamFilter: string;
  onView: (view: CalendarView) => void;
  onDate: (date: ISODate) => void;
  onTiers: (ids: string[]) => void;
  onTeam: (teamId: string) => void;
}) {
  const { org } = useBootstrapData();
  const { schedule } = data;
  const timeFormat = useTimeFormat();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const tiers = useTiers();
  const teams = useTeams();
  const rules = overtimeRules(useSettings().data);
  const openShifts = useOpenShifts();
  // Everyone's published shifts, for overtime worked on other schedules. (The
  // team schedule's days are the viewer's: a day either side covers the edges.)
  const team = useTeamSchedule(addDays(data.from, -1), addDays(data.to, 1));
  const days = useMemo(() => eachDay(data.from, data.to), [data.from, data.to]);
  const compact = days.length > 14;
  // On a phone the people × days grid means scrolling sideways: show a list of days instead.
  const phone = useMediaQuery('(max-width: 639px)');
  const holidays = useHolidays(data.from, data.to);
  const queryKey = keys.schedule(schedule.id, data.from, data.to);

  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<null | { all: boolean; notify: boolean }>(null);
  const [discarding, setDiscarding] = useState(false);
  const [naming, setNaming] = useState<null | 'create' | 'rename'>(null);
  const [deleting, setDeleting] = useState(false);
  const [clearingWeek, setClearingWeek] = useState<BuilderShift | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['schedule', schedule.id] });
    void queryClient.invalidateQueries({ queryKey: keys.schedules });
    void queryClient.invalidateQueries({ queryKey: keys.overview });
  };

  // ---- data shaping -------------------------------------------------------
  const tierList = tiers.data ?? [];
  const visiblePeople = data.people.filter(
    (p) =>
      (tierFilter.length === 0 || (p.tierId !== null && tierFilter.includes(p.tierId))) &&
      (!teamFilter || p.teamId === teamFilter),
  );
  const groups = groupByTier(visiblePeople, tierList);
  const visibleIds = new Set(visiblePeople.map((p) => p.id));
  // Hours are paid hours: each person's tier can take an unpaid break (lunch) off their shifts.
  const breakByUser = breakMinutesByUser(data.people, tierList);
  const shifts = withBreaks(
    data.shifts.filter((s) => visibleIds.has(s.userId)),
    breakByUser,
  );
  const byUserDay = useMemo(() => groupByUserDay(data.shifts, tz), [data.shifts, tz]);
  // Published shifts going away: shown where the team still sees them.
  const ghosts = useMemo(
    () =>
      groupByUserDay(
        data.removedShifts.map((s) => ({
          ...s,
          userId: s.published!.userId,
          startTime: s.published!.startTime,
          endTime: s.published!.endTime,
          working: s,
        })),
        tz,
      ),
    [data.removedShifts, tz],
  );
  const offByUserDay = useMemo(
    () => timeOffByUserDay(data.timeOff, days, tz),
    [data.timeOff, days, tz],
  );
  const onOtherSchedules = useMemo(() => {
    const byUser = new Map<string, { userId: string; startTime: string; endTime: string }[]>();
    for (const s of team.data?.shifts ?? []) {
      const d = localDate(s.startTime, tz);
      if (s.scheduleId === schedule.id || d < data.from || d > data.to) continue;
      byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s]);
    }
    return byUser;
  }, [team.data, schedule.id, tz, data.from, data.to]);
  const labelsById = new Map(data.labels.map((l) => [l.id, l]));
  const tierColor = new Map(tierList.map((t) => [t.id, t.color]));
  const colorFor = (s: BuilderShift, person?: PersonRow) =>
    (s.labelId ? labelsById.get(s.labelId)?.color : undefined) ??
    (person?.tierId ? tierColor.get(person.tierId) : undefined) ??
    '#a855f7';

  const affectedPeople = useMemo(() => {
    const ids = new Set<string>();
    for (const s of [...data.shifts, ...data.removedShifts]) {
      if (s.changeState === 'unchanged') continue;
      if (s.changeState !== 'removed') ids.add(s.userId);
      if (s.published) ids.add(s.published.userId);
    }
    return ids.size;
  }, [data.shifts, data.removedShifts]);
  const elsewhere = Math.max(0, schedule.pendingChanges - data.changes.total);
  // Open shifts on this schedule in the days shown, not taken yet.
  const openHere = (openShifts.data ?? []).filter(
    (o) =>
      (o.status === 'open' || o.status === 'claimed') &&
      o.scheduleId === schedule.id &&
      localDate(o.startTime, tz) >= data.from &&
      localDate(o.startTime, tz) <= data.to,
  );

  // ---- mutations ------------------------------------------------------------
  const create = useMutation({
    mutationFn: (payload: ShiftPayload) =>
      api.post<BuilderShift>(`/schedules/${schedule.id}/shifts`, payload),
    onSuccess: () => {
      setDialog(null);
      refresh();
    },
  });
  const createMany = useMutation({
    mutationFn: (payload: RepeatPayload) =>
      api.post<RepeatResult>(`/schedules/${schedule.id}/shifts/bulk`, payload),
    onSuccess: ({ created, skipped }, payload) => {
      setDialog(null);
      const days = skipped.map((s) => formatDay(localDate(s.startTime, tz)));
      const name = data.people.find((p) => p.id === payload.userId)?.name ?? 'They';
      const message = created
        ? `Added ${created} shift${created === 1 ? '' : 's'}`
        : 'No shifts added';
      const description =
        skipped.length === 0
          ? 'Publish when you’re ready for the team to see them.'
          : skipped.length <= 3
            ? `Skipped ${skipped.map((s, i) => `${days[i]} (${s.detail})`).join(', ')}.`
            : `Skipped ${skipped.length} days from ${days[0]} to ${days.at(-1)}: ${name} already works or has time off then.`;
      if (created) toast.success(message, { description });
      else toast.warning(message, { description });
      refresh();
    },
  });
  const edit = useMutation({
    mutationFn: ({ shiftId, payload }: { shiftId: string; payload: Partial<ShiftPayload> }) =>
      api.patch<BuilderShift>(`/shifts/${shiftId}`, payload),
    onSuccess: () => {
      setDialog(null);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (shiftId: string) => api.delete<{ pendingRemoval: boolean }>(`/shifts/${shiftId}`),
    onSuccess: ({ pendingRemoval }) => {
      setDialog(null);
      if (pendingRemoval)
        toast('Shift will be removed when you publish', {
          description: 'The team still sees it until then.',
        });
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  // Dragging a tier into a new place: show it at once, save it, and put it back if that fails.
  const reorderTiers = useMutation({
    mutationFn: (ids: string[]) => api.post<Tier[]>('/tiers/reorder', { ids }),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: keys.tiers });
      const before = queryClient.getQueryData<Tier[]>(keys.tiers);
      queryClient.setQueryData<Tier[]>(keys.tiers, (list) =>
        ids
          .map((id, i) => {
            const tier = list?.find((t) => t.id === id);
            return tier ? { ...tier, sortOrder: i + 1 } : null;
          })
          .filter((t): t is Tier => t !== null),
      );
      return { before };
    },
    onError: (e, _ids, context) => {
      queryClient.setQueryData(keys.tiers, context?.before);
      toast.error(e.message);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.tiers }),
  });
  /** `visible` is the new order of the tiers on screen; tiers filtered out keep their places. */
  const onReorderGroups = (visible: string[]) => {
    const all = tierList.map((t) => t.id);
    let i = 0;
    reorderTiers.mutate(all.map((id) => (visible.includes(id) ? visible[i++]! : id)));
  };
  const removeWeek = useMutation({
    mutationFn: ({ shift }: { shift: BuilderShift }) => {
      const first = startOfWeek(localDate(shift.startTime, tz), org.weekStartsOn);
      const range = new URLSearchParams(dayRangeToUtc(first, addDays(first, 6), tz));
      return api.delete<{ removed: number; pendingRemoval: number }>(
        `/users/${shift.userId}/shifts?${range}`,
      );
    },
    onSuccess: (r) => {
      setDialog(null);
      setClearingWeek(null);
      if (r.pendingRemoval)
        toast('Shifts will be removed when you publish', {
          description: 'The team still sees the published ones until then.',
        });
      else toast.success('Shifts removed');
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const restore = useMutation({
    mutationFn: (shiftId: string) => api.post<BuilderShift>(`/shifts/${shiftId}/restore`),
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  });
  const move = useMutation({
    mutationFn: ({
      shift,
      userId,
      day,
      copy,
    }: {
      shift: BuilderShift;
      userId: string;
      day: ISODate;
      copy: boolean;
    }) => {
      const times = moveShiftToDate(shift.startTime, shift.endTime, day, tz);
      return copy
        ? api.post<BuilderShift>(`/schedules/${schedule.id}/shifts`, {
            userId,
            labelId: shift.labelId,
            notes: shift.notes,
            ...times,
          })
        : api.patch<BuilderShift>(`/shifts/${shift.id}`, { userId, ...times });
    },
    onMutate: async ({ shift, userId, day, copy }) => {
      if (copy) return { previous: undefined };
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ScheduleRange>(queryKey);
      const times = moveShiftToDate(shift.startTime, shift.endTime, day, tz);
      queryClient.setQueryData<ScheduleRange>(queryKey, (d) =>
        d
          ? {
              ...d,
              shifts: d.shifts.map((s) => (s.id === shift.id ? { ...s, userId, ...times } : s)),
            }
          : d,
      );
      return { previous };
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(queryKey, ctx.previous);
      toast.error(e.message);
    },
    onSettled: refresh,
  });
  const publish = useMutation({
    mutationFn: ({ all, notify }: { all: boolean; notify: boolean }) =>
      api.post<PublishResult>(`/schedules/${schedule.id}/publish`, {
        ...(all ? {} : { from: data.from, to: data.to }),
        // Only said when quiet, so an older server still works as before.
        ...(notify ? {} : { notify: false }),
      }),
    onSuccess: (r, { notify }) => {
      setPublishing(null);
      const changed = r.added + r.updated + r.removed;
      toast.success(changed ? 'Published' : 'Nothing new to publish', {
        description: !notify
          ? changed
            ? 'No emails were sent. The team can see the changes in the app.'
            : undefined
          : r.emailsQueued
            ? `Emailing ${r.emailsQueued} ${r.emailsQueued === 1 ? 'person' : 'people'} so they can confirm.`
            : changed
              ? 'No one needed an email (all changes were in the past).'
              : undefined,
      });
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const discard = useMutation({
    mutationFn: () =>
      api.post<{ discarded: number }>(`/schedules/${schedule.id}/discard-changes`, {
        from: data.from,
        to: data.to,
      }),
    onSuccess: ({ discarded }) => {
      setDiscarding(false);
      toast.success(`Discarded ${discarded} unpublished change${discarded === 1 ? '' : 's'}`);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const copyWeeks = useMutation({
    mutationFn: () => {
      const length = diffDays(data.from, data.to) + 1;
      return api.post<CopyResult>(`/schedules/${schedule.id}/copy`, {
        from: addDays(data.from, -length),
        to: addDays(data.from, -1),
        targetStart: data.from,
      });
    },
    onSuccess: (r) => {
      toast.success(`Copied ${r.copied} shift${r.copied === 1 ? '' : 's'} as drafts`, {
        description: r.skipped
          ? `${r.skipped} skipped (someone was already booked, or is deactivated).`
          : 'Publish when you’re ready for the team to see them.',
      });
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const destroy = useMutation({
    mutationFn: () => api.delete<{ notified: number }>(`/schedules/${schedule.id}`),
    onSuccess: ({ notified }) => {
      toast.success('Schedule deleted', {
        description: notified
          ? `Told ${notified} ${notified === 1 ? 'person' : 'people'} their shifts were cancelled.`
          : undefined,
      });
      void queryClient.invalidateQueries({ queryKey: keys.schedules });
      navigate('/admin/schedules', { replace: true });
    },
    onError: (e) => toast.error(e.message),
  });

  // ---- drag and drop ----------------------------------------------------------
  const onDragStart = (shift: BuilderShift) => (e: DragEvent<HTMLElement>) => {
    e.dataTransfer.setData('text/plain', shift.id);
    e.dataTransfer.effectAllowed = 'copyMove';
    setDraggingId(shift.id);
  };
  const onDragEnd = () => {
    setDraggingId(null);
    setDropKey(null);
  };
  const cellDrop = (userId: string, day: ISODate) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!draggingId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.altKey || e.ctrlKey || e.metaKey ? 'copy' : 'move';
      setDropKey(`${userId}|${day}`);
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropKey(null);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      const shift = data.shifts.find(
        (s) => s.id === (e.dataTransfer.getData('text/plain') || draggingId),
      );
      const copy = e.altKey || e.ctrlKey || e.metaKey;
      onDragEnd();
      if (!shift) return;
      if (!copy && shift.userId === userId && localDate(shift.startTime, tz) === day) return;
      move.mutate({ shift, userId, day, copy });
    },
  });

  const openCreate = (userId: string, day: ISODate) =>
    setDialog({
      mode: 'create',
      draft: { userId, date: day, start: '09:00', end: '17:00', labelId: null, notes: '' },
    });
  const rangeLabel =
    view === 'day'
      ? formatDay(data.from, 'long')
      : view === 'month'
        ? DateTime.fromISO(data.from).toFormat('LLLL yyyy')
        : formatDateRange(data.from, data.to);
  const current = viewRange(view, today, org.weekStartsOn).from === data.from;
  const changes = data.changes;
  const hasChanges = changes.total > 0;
  // "this week", "this month", "this day"
  const periodWord =
    view === 'day' ? 'day' : view === 'week' ? 'week' : view === '2weeks' ? '2 weeks' : 'month';

  // The day view's timeline, and the people rows shared with the grid.
  const groupHours = (group: { people: PersonRow[] }) => {
    const ids = new Set(group.people.map((p) => p.id));
    return formatHours(totalHours(shifts.filter((s) => ids.has(s.userId))));
  };
  const renderPerson = (person: PersonRow) => {
    const personShifts = shifts.filter((s) => s.userId === person.id);
    const other = withBreaks(onOtherSchedules.get(person.id) ?? [], breakByUser);
    const overtime = overtimeIn(
      [...personShifts, ...other],
      data.from,
      data.to,
      tz,
      org.weekStartsOn,
      rules,
    );
    if (other.length) {
      overtime.reasons.push(
        `Counting ${other.length} published shift${other.length === 1 ? '' : 's'} on other schedules`,
      );
    }
    return (
      <div className="flex items-center gap-2.5">
        <Avatar name={person.name} size="sm" className="hidden sm:inline-flex" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-900">{person.name}</p>
          <p className="text-xs text-slate-500">
            {personShifts.length
              ? `${formatHours(totalHours(personShifts))} · ${personShifts.length} shift${personShifts.length === 1 ? '' : 's'}`
              : 'No shifts'}
            {!person.active && ' · deactivated'}
          </p>
          {overtime.hours > 0 && (
            <span title={overtime.reasons.join('\n')}>
              <Badge tone="amber" className="mt-0.5 px-1.5 py-0 text-[11px]">
                <AlarmClock className="size-3" aria-hidden />
                {formatHours(overtime.hours)} overtime
              </Badge>
            </span>
          )}
        </div>
      </div>
    );
  };
  const barsFor = (person: PersonRow): TimelineBar[] => {
    const day = data.from;
    const mine = (byUserDay.get(person.id)?.get(day) ?? []).map((s): TimelineBar => ({
      id: s.id,
      startTime: s.startTime,
      endTime: s.endTime,
      unpaidBreakMinutes: breakByUser.get(person.id) ?? 0,
      color: colorFor(s, person),
      labelName: s.labelId ? labelsById.get(s.labelId)?.name : undefined,
      notes: s.notes,
      status: s.published ? s.status : null,
      change: s.changeState === 'new' || s.changeState === 'updated' ? s.changeState : null,
      draggable: true,
      dragging: draggingId === s.id,
      onDragStart: onDragStart(s),
      onDragEnd,
      onClick: () => setDialog({ mode: 'edit', shift: s }),
    }));
    const gone = (ghosts.get(person.id)?.get(day) ?? []).map((g): TimelineBar =>
      g.working.changeState === 'removed'
        ? {
            id: g.id,
            startTime: g.startTime,
            endTime: g.endTime,
            color: colorFor(g.working, person),
            status: null,
            removed: true,
            onRestore: () => restore.mutate(g.id),
          }
        : {
            id: g.id,
            startTime: g.startTime,
            endTime: g.endTime,
            color: colorFor(g.working, person),
            status: null,
            removed: true,
            caption: `Moved to ${formatDay(localDate(g.working.startTime, tz))}`,
            onClick: () => onDate(localDate(g.working.startTime, tz)),
          },
    );
    return [...mine, ...gone];
  };

  const renderShiftCell = (person: PersonRow, day: ISODate, list = false) => {
    const cellShifts = byUserDay.get(person.id)?.get(day) ?? [];
    const cellGhosts = ghosts.get(person.id)?.get(day) ?? [];
    const off = offByUserDay.get(person.id)?.get(day) ?? [];
    return (
      <div className={cx('flex flex-col gap-1', !list && 'min-h-[4.5rem]')}>
        {off.map((entry) => (
          <TimeOffChip key={entry.id} entry={entry} tz={tz} compact={compact} />
        ))}
        {cellShifts.map((s) => (
          <ShiftChip
            key={s.id}
            shift={s}
            tz={tz}
            compact={compact}
            color={colorFor(s, person)}
            labelName={s.labelId ? labelsById.get(s.labelId)?.name : undefined}
            status={s.published ? s.status : null}
            change={s.changeState === 'new' || s.changeState === 'updated' ? s.changeState : null}
            draggable
            dragging={draggingId === s.id}
            onDragStart={onDragStart(s)}
            onDragEnd={onDragEnd}
            onClick={() => setDialog({ mode: 'edit', shift: s })}
          />
        ))}
        {cellGhosts.map((g) =>
          g.working.changeState === 'removed' ? (
            <ShiftChip
              key={g.id}
              shift={g}
              tz={tz}
              compact={compact}
              color={colorFor(g.working, person)}
              status={null}
              removed
              onRestore={() => restore.mutate(g.id)}
            />
          ) : (
            <ShiftChip
              key={g.id}
              shift={g}
              tz={tz}
              compact={compact}
              color={colorFor(g.working, person)}
              status={null}
              removed
              caption={`Moved to ${formatDay(localDate(g.working.startTime, tz))}`}
              onClick={() => onDate(localDate(g.working.startTime, tz))}
            />
          ),
        )}
        {person.active && (
          <button
            type="button"
            onClick={() => openCreate(person.id, day)}
            aria-label={`Add shift for ${person.name} on ${formatDay(day)}`}
            className="flex h-6 w-full items-center justify-center rounded-md border border-dashed border-slate-300 text-slate-400 opacity-0 transition hover:border-brand-400 hover:bg-brand-50 hover:text-brand-600 focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <Plus className="size-3.5" />
          </button>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <ScheduleSwitcher
            current={schedule}
            schedules={schedules}
            onSelect={(sid) => navigate(`/admin/schedules/${sid}${location.search}`)}
            onCreate={() => setNaming('create')}
            onRename={() => setNaming('rename')}
            onDelete={() => setDeleting(true)}
          />
          <p className="mt-1 text-sm text-slate-500">
            Every tier on one calendar · {shifts.length} shift{shifts.length === 1 ? '' : 's'} ·{' '}
            {formatHours(totalHours(shifts))} this {periodWord}
            {schedule.publishedAt &&
              ` · last published ${formatTimestamp(schedule.publishedAt, tz, timeFormat)}${schedule.publishedByName ? ` by ${schedule.publishedByName}` : ''}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasChanges && (
            <Button
              icon={<Undo2 className="size-4" />}
              onClick={() => setDiscarding(true)}
              aria-label="Discard changes"
            >
              <span className="hidden sm:inline">Discard</span>
            </Button>
          )}
          <Button
            variant="primary"
            icon={<Send className="size-4" />}
            disabled={!hasChanges && elsewhere === 0}
            onClick={() => setPublishing({ all: !hasChanges, notify: true })}
          >
            {hasChanges
              ? `Publish ${changes.total} change${changes.total === 1 ? '' : 's'}`
              : elsewhere
                ? `Publish ${elsewhere} elsewhere`
                : 'All published'}
          </Button>
          <Menu
            label="More actions"
            trigger={<Ellipsis className="size-4" />}
            items={[
              ...(view !== 'month'
                ? [
                    {
                      label:
                        view === 'day'
                          ? 'Copy the day before here'
                          : view === 'week'
                            ? 'Copy last week here'
                            : 'Copy the 2 weeks before',
                      icon: <CopyPlus />,
                      onSelect: () => copyWeeks.mutate(),
                      disabled: copyWeeks.isPending,
                    },
                  ]
                : []),
              {
                label: `Publish all changes (${schedule.pendingChanges})`,
                icon: <Send />,
                onSelect: () => setPublishing({ all: true, notify: true }),
                disabled: schedule.pendingChanges === 0,
              },
            ]}
          />
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <CalendarNav
          label={rangeLabel}
          onPrev={() => onDate(stepView(view, data.from, -1))}
          onNext={() => onDate(stepView(view, data.from, 1))}
          onToday={() => onDate(today)}
          isCurrent={current}
          value={date}
          onPick={onDate}
        />
        <Tabs value={view} onChange={onView} options={VIEWS} />
        {loading && <Spinner className="size-4" />}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {tierList.length > 1 && (
          <TierFilter tiers={tierList} selected={tierFilter} onChange={onTiers} />
        )}
        {!!teams.data?.length && (
          <div className="w-40">
            <Select aria-label="Team" value={teamFilter} onChange={(e) => onTeam(e.target.value)}>
              <option value="">All teams</option>
              {teams.data.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      {hasChanges ? (
        <Banner tone="amber">
          <strong>
            {changes.total} unpublished change{changes.total === 1 ? '' : 's'} this {periodWord}
          </strong>{' '}
          (
          {[
            changes.added && `${changes.added} new`,
            changes.updated && `${changes.updated} edited`,
            changes.removed && `${changes.removed} removed`,
          ]
            .filter(Boolean)
            .join(', ')}
          ). The team sees the published version until you publish.
        </Banner>
      ) : null}
      {elsewhere > 0 && schedule.firstChangeDate && (
        <Banner tone="slate">
          {elsewhere} more unpublished change{elsewhere === 1 ? '' : 's'} on other dates
          {schedule.lastChangeDate &&
            ` (${formatDateRange(schedule.firstChangeDate, schedule.lastChangeDate)})`}
          .{' '}
          <button
            type="button"
            className="font-semibold text-brand-600 hover:underline"
            onClick={() =>
              onDate(
                schedule.firstChangeDate! < data.from || schedule.firstChangeDate! > data.to
                  ? schedule.firstChangeDate!
                  : schedule.lastChangeDate!,
              )
            }
          >
            Show me
          </button>
        </Banner>
      )}
      {openHere.length > 0 && (
        <Banner tone="slate">
          <strong>
            {openHere.length} open shift{openHere.length === 1 ? '' : 's'} this {periodWord}
          </strong>
          :{' '}
          {openHere
            .slice(0, 3)
            .map(
              (o) =>
                `${formatShiftWhen(o.startTime, o.endTime, tz, timeFormat)} (${o.tier.name}${o.claimedBy ? `, picked up by ${o.claimedBy.name}` : ''})`,
            )
            .join('; ')}
          {openHere.length > 3 && ` and ${openHere.length - 3} more`}.{' '}
          <Link
            to="/admin/shift-requests?tab=open"
            className="font-semibold text-brand-600 hover:underline"
          >
            Manage open shifts
          </Link>
        </Banner>
      )}

      {phone && view !== 'month' ? (
        <ScheduleAgenda
          days={days}
          today={today}
          holidays={holidays}
          groups={groups}
          hasContent={(person, day) =>
            !!(
              byUserDay.get(person.id)?.get(day)?.length ||
              ghosts.get(person.id)?.get(day)?.length ||
              offByUserDay.get(person.id)?.get(day)?.length
            )
          }
          daySummary={(d) => {
            const dayShifts = shifts.filter((s) => localDate(s.startTime, tz) === d);
            return dayShifts.length
              ? `${dayShifts.length} · ${formatHours(totalHours(dayShifts))}`
              : '—';
          }}
          renderPerson={renderPerson}
          renderCell={(person, day) => renderShiftCell(person, day, true)}
          onAddDay={
            groups[0]?.people[0] ? (day) => openCreate(groups[0]!.people[0]!.id, day) : undefined
          }
          empty="No one matches these filters. Add people on the People page."
          footer={
            <div className="space-y-1 px-1 pt-1 pb-3 text-xs text-slate-500">
              <ScheduleLegend showChanges />
              <p>Tap a shift to edit it · times in {zoneLabel(tz)}</p>
            </div>
          }
        />
      ) : view === 'day' ? (
        <DayTimeline
          day={data.from}
          today={today}
          tz={tz}
          timeFormat={timeFormat}
          holidays={holidays.get(data.from)}
          groups={groups}
          onReorderGroups={onReorderGroups}
          collapseKey={COLLAPSED_TIERS_KEY}
          bars={barsFor}
          timeOff={(person) => offByUserDay.get(person.id)?.get(data.from) ?? []}
          groupHours={groupHours}
          renderPerson={renderPerson}
          onAdd={(person, hour) => {
            const pad = (h: number) => `${String(h).padStart(2, '0')}:00`;
            setDialog({
              mode: 'create',
              draft: {
                userId: person.id,
                date: data.from,
                start: pad(hour),
                end: pad((hour + 8) % 24),
                labelId: null,
                notes: '',
              },
            });
          }}
          trackProps={(person) => ({
            ...cellDrop(person.id, data.from),
            className: cx(
              dropKey === `${person.id}|${data.from}` &&
                'bg-brand-50 ring-2 ring-inset ring-brand-400',
            ),
          })}
          empty="No one matches these filters. Add people on the People page."
          footer={
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200/70 px-4 py-3 text-xs text-slate-500">
              <ScheduleLegend showChanges />
              <p>
                Click an empty spot to add a shift · drag a shift onto someone else to give it to
                them · hold{' '}
                <kbd className="rounded border border-slate-300 bg-slate-50 px-1">Alt</kbd> or{' '}
                <kbd className="rounded border border-slate-300 bg-slate-50 px-1">Ctrl</kbd> to copy
                · times in {zoneLabel(tz)}
              </p>
            </div>
          }
        />
      ) : (
        <ScheduleGrid
          days={days}
          today={today}
          holidays={holidays}
          compact={compact}
          groups={groups}
          onReorderGroups={onReorderGroups}
          collapseKey={COLLAPSED_TIERS_KEY}
          dayWidth={[80, 128]}
          rowHeight="h-20"
          daySummary={(d) => {
            const dayShifts = shifts.filter((s) => localDate(s.startTime, tz) === d);
            if (!dayShifts.length) return '—';
            return compact
              ? String(dayShifts.length)
              : `${dayShifts.length} · ${formatHours(totalHours(dayShifts))}`;
          }}
          groupHours={groupHours}
          renderPerson={renderPerson}
          cellProps={(person, day) => ({
            ...cellDrop(person.id, day),
            className: cx(
              'group transition-colors',
              dropKey === `${person.id}|${day}` && 'bg-brand-50 ring-2 ring-inset ring-brand-400',
            ),
          })}
          renderCell={renderShiftCell}
          empty="No one matches these filters. Add people on the People page."
          footer={
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200/70 px-4 py-3 text-xs text-slate-500">
              <ScheduleLegend showChanges />
              <p>
                Drag shifts to move them · hold{' '}
                <kbd className="rounded border border-slate-300 bg-slate-50 px-1">Alt</kbd> or{' '}
                <kbd className="rounded border border-slate-300 bg-slate-50 px-1">Ctrl</kbd> to copy
                · times in {zoneLabel(tz)}
              </p>
            </div>
          }
        />
      )}

      {dialog?.mode === 'create' && (
        <ShiftDialog
          mode="create"
          initial={dialog.draft}
          tz={tz}
          people={data.people}
          tiers={tierList}
          labels={data.labels}
          timeOff={data.timeOff}
          allShifts={data.shifts}
          saving={create.isPending || createMany.isPending}
          error={create.error ?? createMany.error}
          onSave={(payload) => create.mutate(payload)}
          onSaveMany={(payload) => createMany.mutate(payload)}
          onClose={() => {
            setDialog(null);
            create.reset();
            createMany.reset();
          }}
        />
      )}
      {dialog?.mode === 'edit' && (
        <ShiftDialog
          key={dialog.shift.id}
          mode="edit"
          shift={dialog.shift}
          initial={draftFromShift(dialog.shift, tz)}
          tz={tz}
          people={data.people}
          tiers={tierList}
          labels={data.labels}
          timeOff={data.timeOff}
          allShifts={data.shifts}
          saving={edit.isPending}
          deleting={remove.isPending}
          error={edit.error}
          onSave={(payload) => edit.mutate({ shiftId: dialog.shift.id, payload })}
          onDelete={() => remove.mutate(dialog.shift.id)}
          onDeleteWeek={() => setClearingWeek(dialog.shift)}
          onDuplicate={(draft) => {
            edit.reset();
            setDialog({ mode: 'create', draft: { ...draft, date: addDays(draft.date, 1) } });
          }}
          onClose={() => {
            setDialog(null);
            edit.reset();
          }}
        />
      )}
      {clearingWeek && (
        <ConfirmDialog
          title={`Remove all of ${data.people.find((p) => p.id === clearingWeek.userId)?.name ?? 'their'} shifts that week?`}
          confirmLabel="Remove their week"
          danger
          loading={removeWeek.isPending}
          onConfirm={() => removeWeek.mutate({ shift: clearingWeek })}
          onClose={() => setClearingWeek(null)}
        >
          {(() => {
            const first = startOfWeek(localDate(clearingWeek.startTime, tz), org.weekStartsOn);
            return `Every shift they have in the week of ${formatDateRange(first, addDays(first, 6))}, on any schedule. Shifts the team can already see stay until you publish.`;
          })()}
        </ConfirmDialog>
      )}
      {publishing && (
        <PublishDialog
          all={publishing.all}
          notify={publishing.notify}
          onNotify={(notify) => setPublishing({ ...publishing, notify })}
          rangeLabel={rangeLabel}
          changes={changes}
          affectedPeople={affectedPeople}
          totalChanges={schedule.pendingChanges}
          loading={publish.isPending}
          onToggleAll={(all) => setPublishing({ ...publishing, all })}
          onConfirm={() => publish.mutate({ all: publishing.all, notify: publishing.notify })}
          onClose={() => setPublishing(null)}
        />
      )}
      {discarding && (
        <ConfirmDialog
          title={`Discard changes for ${rangeLabel}?`}
          confirmLabel="Discard changes"
          danger
          loading={discard.isPending}
          onConfirm={() => discard.mutate()}
          onClose={() => setDiscarding(false)}
        >
          These days go back to exactly what the team sees now. {changes.total} change
          {changes.total === 1 ? '' : 's'} will be lost; other dates aren't touched.
        </ConfirmDialog>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${schedule.name}?`}
          confirmLabel="Delete schedule"
          danger
          loading={destroy.isPending}
          onConfirm={() => destroy.mutate()}
          onClose={() => setDeleting(false)}
        >
          All of its shifts are deleted. Everyone with an upcoming published shift on it gets an
          email saying it’s cancelled. This can’t be undone.
        </ConfirmDialog>
      )}
      {naming && (
        <ScheduleNameDialog
          schedule={naming === 'rename' ? schedule : null}
          onClose={() => setNaming(null)}
          onSaved={(saved) => {
            void queryClient.invalidateQueries({ queryKey: keys.schedules });
            refresh();
            if (naming === 'create') navigate(`/admin/schedules/${saved.id}`);
          }}
        />
      )}
    </>
  );
}

function Banner({ tone, children }: { tone: 'slate' | 'amber'; children: ReactNode }) {
  return (
    <div
      className={cx(
        'mb-3 rounded-xl px-4 py-2.5 text-sm ring-1 ring-inset',
        tone === 'amber'
          ? 'bg-amber-50 text-amber-900 ring-amber-200'
          : 'bg-slate-100/80 text-slate-700 ring-slate-200',
      )}
    >
      {children}
    </div>
  );
}

function PublishDialog({
  all,
  notify,
  onNotify,
  rangeLabel,
  changes,
  affectedPeople,
  totalChanges,
  loading,
  onToggleAll,
  onConfirm,
  onClose,
}: {
  all: boolean;
  /** Email everyone affected (otherwise publish quietly). */
  notify: boolean;
  onNotify: (notify: boolean) => void;
  rangeLabel: string;
  changes: ScheduleRange['changes'];
  affectedPeople: number;
  totalChanges: number;
  loading: boolean;
  onToggleAll: (all: boolean) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const others = totalChanges - changes.total;
  return (
    <ConfirmDialog
      title={all ? 'Publish every unpublished change?' : `Publish ${rangeLabel}?`}
      confirmLabel={notify ? 'Publish & notify' : 'Publish without notifying'}
      loading={loading}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      {all ? (
        <p>
          All {totalChanges} unpublished change{totalChanges === 1 ? '' : 's'} on this schedule
          become visible to the team.
          {notify &&
            ' Everyone affected gets one email with their new, changed or cancelled shifts.'}
        </p>
      ) : (
        <p>
          {[
            changes.added && `${changes.added} new`,
            changes.updated && `${changes.updated} changed`,
            changes.removed && `${changes.removed} removed`,
          ]
            .filter(Boolean)
            .join(', ')}{' '}
          shift{changes.total === 1 ? '' : 's'} become visible to the team.
          {notify && (
            <>
              {' '}
              {affectedPeople} {affectedPeople === 1 ? 'person gets' : 'people get'} an email with a{' '}
              <strong>Confirm</strong> button. Changed shifts need to be confirmed again.
            </>
          )}
        </p>
      )}
      {others > 0 && changes.total > 0 && (
        <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => onToggleAll(e.target.checked)}
            className="size-4 accent-brand-600"
          />
          Also publish the {others} change{others === 1 ? '' : 's'} on other dates
        </label>
      )}
      <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={notify}
          onChange={(e) => onNotify(e.target.checked)}
          className="mt-0.5 size-4 accent-brand-600"
        />
        <span>
          Email the team about these changes
          {!notify && (
            <span className="mt-1 block text-slate-500">
              No emails will be sent, now or as a reminder. The shifts still show up in the app (and
              in Google Calendar for anyone who has that turned on), and people can confirm them
              there.
            </span>
          )}
        </span>
      </label>
    </ConfirmDialog>
  );
}

function ScheduleNameDialog({
  schedule,
  onClose,
  onSaved,
}: {
  schedule: ScheduleSummary | null;
  onClose: () => void;
  onSaved: (schedule: ScheduleSummary) => void;
}) {
  const [name, setName] = useState(schedule?.name ?? '');
  const save = useMutation({
    mutationFn: () =>
      schedule
        ? api.patch<ScheduleSummary>(`/schedules/${schedule.id}`, { name })
        : api.post<ScheduleSummary>('/schedules', { name }),
    onSuccess: (saved) => {
      toast.success(schedule ? 'Schedule renamed' : `${saved.name} created`);
      onSaved(saved);
      onClose();
    },
  });
  const errors = fieldErrors(save.error);
  return (
    <Modal
      title={schedule ? 'Rename schedule' : 'New schedule'}
      description={
        schedule
          ? undefined
          : 'An extra calendar for a separate roster (a project, a location, holiday coverage). Like the main schedule, it covers every tier.'
      }
      onClose={onClose}
      onSubmit={() => save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {schedule ? 'Save' : 'Create schedule'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={formMessage(save.error, ['name'])} />
        <Field label="Name" error={errors.name}>
          <Input
            value={name}
            required
            maxLength={80}
            autoFocus
            placeholder="e.g. Holiday coverage"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
