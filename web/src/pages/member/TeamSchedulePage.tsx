import {
  eachDay,
  formatDateRange,
  formatDay,
  formatHours,
  formatTimeRange,
  todayIn,
  type ISODate,
} from '@shared/time';
import type { PersonRow, ShiftView, Tier, TimeOffEntry } from '@shared/types';
import type { Holiday } from '@shared/holidays';
import { DateTime } from 'luxon';
import { Users } from 'lucide-react';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { useTeamSchedule, useTeams, useTiers } from '../../api/queries';
import { CalendarNav, HolidayBadge, TierFilter } from '../../components/schedule/CalendarBits';
import { ScheduleGrid } from '../../components/schedule/ScheduleGrid';
import { ScheduleLegend, ShiftChip, TimeOffChip } from '../../components/schedule/ShiftChip';
import { Select } from '../../components/ui/Form';
import {
  Avatar,
  Badge,
  Card,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  Spinner,
  Tabs,
} from '../../components/ui/Misc';
import { cx } from '../../lib/cx';
import { useHolidays } from '../../lib/holidays';
import {
  groupByDay,
  groupByTier,
  groupByUserDay,
  shiftColor,
  stepView,
  timeOffByUserDay,
  totalHours,
  viewRange,
  type CalendarView,
} from '../../lib/schedule';
import { useBootstrapData, useCurrentUser, useTimeFormat, useViewerZone } from '../../lib/session';
import { zoneLabel } from '../../lib/timezones';

const VIEW_KEY = 'toretto:team-view';
const NO_TIERS: Tier[] = [];
const VIEWS: { value: CalendarView; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: '2weeks', label: '2 weeks' },
  { value: 'month', label: 'Month' },
];

function savedView(): CalendarView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === '2weeks' || v === 'month' ? v : 'week';
  } catch {
    return 'week';
  }
}

export default function TeamSchedulePage() {
  const { org } = useBootstrapData();
  const tz = useViewerZone();
  const today = todayIn(tz);
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') as CalendarView | null) ?? savedView();
  const date = params.get('date') ?? today;
  const tiersParam = params.get('tiers') ?? '';
  const tierFilter = useMemo(() => tiersParam.split(',').filter(Boolean), [tiersParam]);
  const teamFilter = params.get('team') ?? '';
  const scheduleFilter = params.get('schedule') ?? '';
  const { from, to } = viewRange(view, date, org.weekStartsOn);

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
  const setView = (v: CalendarView) => {
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Just not remembered.
    }
    update({ view: v });
  };
  const setDate = (d: ISODate) => update({ date: d === today ? null : d });

  return (
    <TeamCalendar
      from={from}
      to={to}
      view={view}
      date={date}
      today={today}
      tz={tz}
      tierFilter={tierFilter}
      teamFilter={teamFilter}
      scheduleFilter={scheduleFilter}
      onView={setView}
      onDate={setDate}
      onFilter={update}
    />
  );
}

function TeamCalendar({
  from,
  to,
  view,
  date,
  today,
  tz,
  tierFilter,
  teamFilter,
  scheduleFilter,
  onView,
  onDate,
  onFilter,
}: {
  from: ISODate;
  to: ISODate;
  view: CalendarView;
  date: ISODate;
  today: ISODate;
  tz: string;
  tierFilter: string[];
  teamFilter: string;
  scheduleFilter: string;
  onView: (view: CalendarView) => void;
  onDate: (date: ISODate) => void;
  onFilter: (patch: Record<string, string | null>) => void;
}) {
  const me = useCurrentUser();
  const { org } = useBootstrapData();
  const days = useMemo(() => eachDay(from, to), [from, to]);
  const compact = days.length > 14;
  const tiers = useTiers();
  const teams = useTeams();
  const schedule = useTeamSchedule(from, to);
  const holidays = useHolidays(from, to);
  const data = schedule.data;
  const tierList = tiers.data ?? NO_TIERS;

  // Everyone is on the calendar; the filters only narrow what's shown.
  const people = useMemo(
    () =>
      (data?.people ?? []).filter(
        (p) =>
          (tierFilter.length === 0 || (p.tierId !== null && tierFilter.includes(p.tierId))) &&
          (!teamFilter || p.teamId === teamFilter),
      ),
    [data, tierFilter, teamFilter],
  );
  const shifts = useMemo(() => {
    const ids = new Set(people.map((p) => p.id));
    return (data?.shifts ?? []).filter(
      (s) => ids.has(s.userId) && (!scheduleFilter || s.scheduleId === scheduleFilter),
    );
  }, [data, people, scheduleFilter]);
  const groups = useMemo(() => groupByTier(people, tierList, me.id), [people, tierList, me.id]);
  const byUserDay = useMemo(() => groupByUserDay(shifts, tz), [shifts, tz]);
  const byDay = useMemo(() => groupByDay(shifts, tz), [shifts, tz]);
  const offByUserDay = useMemo(
    () => timeOffByUserDay(data?.timeOff ?? [], days, tz),
    [data, days, tz],
  );
  const peopleById = new Map(people.map((p) => [p.id, p]));
  const manySchedules = (data?.schedules.length ?? 0) > 1;

  const rangeLabel =
    view === 'month' ? DateTime.fromISO(from).toFormat('LLLL yyyy') : formatDateRange(from, to);
  const current = viewRange(view, today, org.weekStartsOn).from === from;
  const periodWord = view === 'week' ? 'week' : view === '2weeks' ? '2 weeks' : 'month';

  return (
    <>
      <PageHeader
        title="Team schedule"
        description={`Who's working across every tier · times in ${zoneLabel(tz)}`}
      />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <CalendarNav
          label={rangeLabel}
          onPrev={() => onDate(stepView(view, from, -1))}
          onNext={() => onDate(stepView(view, from, 1))}
          onToday={() => onDate(today)}
          isCurrent={current}
          value={date}
          onPick={onDate}
        />
        <Tabs value={view} onChange={onView} options={VIEWS} />
        {schedule.isFetching && !schedule.isLoading && <Spinner className="size-4" />}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {tierList.length > 1 && (
          <TierFilter
            tiers={tierList}
            selected={tierFilter}
            onChange={(ids) => onFilter({ tiers: ids.join(',') || null })}
          />
        )}
        {!!teams.data?.length && (
          <div className="w-40">
            <Select
              aria-label="Team"
              value={teamFilter}
              onChange={(e) => onFilter({ team: e.target.value || null })}
            >
              <option value="">All teams</option>
              {teams.data.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        {manySchedules && data && (
          <div className="w-48">
            <Select
              aria-label="Schedule"
              value={scheduleFilter}
              onChange={(e) => onFilter({ schedule: e.target.value || null })}
            >
              <option value="">All schedules</option>
              {data.schedules.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      {schedule.isLoading ? (
        <LoadingBlock />
      ) : schedule.isError ? (
        <ErrorBlock error={schedule.error} onRetry={() => void schedule.refetch()} />
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Users />}
            title="No one to show"
            description="No one matches these filters. Try All tiers."
          />
        </Card>
      ) : (
        <>
          {/* Desktop / tablet: people × days grid */}
          <ScheduleGrid
            className="hidden md:block"
            days={days}
            today={today}
            holidays={holidays}
            compact={compact}
            groups={groups}
            dayWidth={[78, 110]}
            rowHeight="h-16"
            highlight={(person) => person.id === me.id}
            daySummary={(d) => {
              const working = new Set((byDay.get(d) ?? []).map((s) => s.userId)).size;
              if (!working) return '—';
              return compact ? String(working) : `${working} working`;
            }}
            groupHours={(group) => {
              const ids = new Set(group.people.map((p) => p.id));
              return formatHours(totalHours(shifts.filter((s) => ids.has(s.userId))));
            }}
            renderPerson={(person) => {
              const all = [...(byUserDay.get(person.id)?.values() ?? [])].flat();
              return (
                <div className="flex items-center gap-2.5">
                  <Avatar name={person.name} size="sm" />
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-medium text-slate-900">
                      <span className="truncate">{person.name}</span>
                      {person.id === me.id && <Badge tone="brand">You</Badge>}
                    </p>
                    <p className="text-xs text-slate-500">
                      {all.length ? formatHours(totalHours(all)) : `Off this ${periodWord}`}
                    </p>
                  </div>
                </div>
              );
            }}
            renderCell={(person, day) => {
              const off = offByUserDay.get(person.id)?.get(day) ?? [];
              return (
                <div className="flex flex-col gap-1">
                  {off.map((entry) => (
                    <TimeOffChip key={entry.id} entry={entry} tz={tz} compact={compact} />
                  ))}
                  {(byUserDay.get(person.id)?.get(day) ?? []).map((s) => (
                    <ShiftChip
                      key={s.id}
                      shift={s}
                      tz={tz}
                      compact={compact}
                      color={shiftColor(s)}
                      labelName={compact ? null : s.label?.name}
                      caption={
                        manySchedules && !scheduleFilter && !compact ? s.scheduleName : undefined
                      }
                      status={s.status}
                      mine={person.id === me.id}
                    />
                  ))}
                </div>
              );
            }}
          />

          {/* Phones: agenda by day */}
          <div className="space-y-4 md:hidden">
            {days
              .filter(
                (day) =>
                  view === 'week' ||
                  day === today ||
                  holidays.has(day) ||
                  byDay.has(day) ||
                  people.some((p) => offByUserDay.get(p.id)?.has(day)),
              )
              .map((day) => (
                <DayAgenda
                  key={day}
                  day={day}
                  today={today}
                  tz={tz}
                  meId={me.id}
                  holidays={holidays.get(day)}
                  shifts={byDay.get(day) ?? []}
                  peopleById={peopleById}
                  off={people.flatMap((person) =>
                    (offByUserDay.get(person.id)?.get(day) ?? []).map((entry) => ({
                      person,
                      entry,
                    })),
                  )}
                  showSchedule={manySchedules && !scheduleFilter}
                />
              ))}
          </div>
          <div className="mt-4">
            <ScheduleLegend />
          </div>
        </>
      )}
    </>
  );
}

function DayAgenda({
  day,
  today,
  tz,
  meId,
  holidays,
  shifts,
  peopleById,
  off,
  showSchedule,
}: {
  day: ISODate;
  today: ISODate;
  tz: string;
  meId: string;
  holidays: Holiday[] | undefined;
  shifts: ShiftView[];
  peopleById: Map<string, PersonRow>;
  /** Who's off that day (with their hours, for part of a day). */
  off: { person: PersonRow; entry: TimeOffEntry }[];
  showSchedule: boolean;
}) {
  const timeFormat = useTimeFormat();
  const isToday = day === today;
  return (
    <Card>
      <div
        className={cx(
          'flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5',
          isToday && 'bg-brand-50',
        )}
      >
        <p
          className={cx(
            'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold',
            isToday ? 'text-brand-700' : 'text-slate-800',
          )}
        >
          <span>
            {formatDay(day)} {isToday && <span className="font-normal">· Today</span>}
          </span>
          {holidays?.length ? <HolidayBadge holidays={holidays} /> : null}
        </p>
        <span className="shrink-0 text-xs text-slate-500">
          {shifts.length} shift{shifts.length === 1 ? '' : 's'}
        </span>
      </div>
      {shifts.length === 0 && off.length === 0 ? (
        <p className="px-4 py-3 text-sm text-slate-400">No one scheduled</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {shifts.map((s) => {
            const person = peopleById.get(s.userId);
            return (
              <li
                key={s.id}
                className={cx(
                  'flex items-center gap-3 px-4 py-2.5',
                  s.userId === meId && 'bg-brand-50/50',
                )}
              >
                <span
                  className="h-8 w-1 shrink-0 rounded-full"
                  style={{ backgroundColor: shiftColor(s), boxShadow: `0 0 10px ${shiftColor(s)}` }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">
                    {person?.name ?? 'Someone'}{' '}
                    {s.userId === meId && <Badge tone="brand">You</Badge>}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {[
                      formatTimeRange(s.startTime, s.endTime, tz, { format: timeFormat }),
                      s.tier?.name,
                      s.label?.name,
                      showSchedule && s.scheduleName,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <Badge tone={s.status === 'confirmed' ? 'green' : 'amber'}>
                  {s.status === 'confirmed' ? 'Confirmed' : 'Pending'}
                </Badge>
              </li>
            );
          })}
          {off.map(({ person, entry }) => (
            <li
              key={entry.id}
              className="stripes flex items-center gap-3 px-4 py-2 text-sm text-slate-600"
            >
              <Avatar name={person.name} size="sm" /> {person.name} · off
              {entry.startTime &&
                entry.endTime &&
                ` ${formatTimeRange(entry.startTime, entry.endTime, tz, { format: timeFormat })}`}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
