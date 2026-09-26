import {
  addDays,
  eachDay,
  formatDay,
  formatHours,
  formatTimeRange,
  isWeekend,
  startOfWeek,
  todayIn,
} from '@shared/time';
import type { PersonRow, ShiftView, Tier } from '@shared/types';
import { DateTime } from 'luxon';
import { Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTeamSchedule, useTeams, useTiers } from '../../api/queries';
import { ScheduleLegend, ShiftChip, TimeOffChip } from '../../components/schedule/ShiftChip';
import { WeekNav } from '../../components/schedule/WeekNav';
import { Select } from '../../components/ui/Form';
import {
  Avatar,
  Badge,
  Card,
  ColorDot,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  Spinner,
} from '../../components/ui/Misc';
import { cx } from '../../lib/cx';
import { groupByDay, groupByUserDay, timeOffByUserDay, totalHours } from '../../lib/schedule';
import { useBootstrapData, useCurrentUser, useViewerZone } from '../../lib/session';
import { zoneLabel } from '../../lib/timezones';

interface Group {
  key: string;
  tier: Pick<Tier, 'name' | 'color'> | null;
  people: PersonRow[];
}

function groupPeople(people: PersonRow[], tiers: Tier[], meId: string): Group[] {
  const groups: Group[] = tiers.map((t) => ({ key: t.id, tier: t, people: [] }));
  const other: Group = { key: 'other', tier: null, people: [] };
  for (const person of people) {
    (groups.find((g) => g.key === person.tierId) ?? other).people.push(person);
  }
  for (const g of [...groups, other]) {
    g.people.sort((a, b) =>
      a.id === meId ? -1 : b.id === meId ? 1 : a.name.localeCompare(b.name),
    );
  }
  return [...groups, other].filter((g) => g.people.length > 0);
}

export default function TeamSchedulePage() {
  const me = useCurrentUser();
  const { org } = useBootstrapData();
  const tz = useViewerZone();
  const today = todayIn(tz);
  const thisWeek = startOfWeek(today, org.weekStartsOn);
  const [weekStart, setWeekStart] = useState(thisWeek);
  const [tierId, setTierId] = useState(me.tierId ?? '');
  const [teamId, setTeamId] = useState('');
  const weekEnd = addDays(weekStart, 6);
  const days = useMemo(() => eachDay(weekStart, weekEnd), [weekStart, weekEnd]);

  const tiers = useTiers();
  const teams = useTeams();
  const schedule = useTeamSchedule(weekStart, weekEnd, tierId, teamId);

  const data = schedule.data;
  const byUserDay = useMemo(() => groupByUserDay(data?.shifts ?? [], tz), [data, tz]);
  const offByUserDay = useMemo(() => timeOffByUserDay(data?.timeOff ?? [], days), [data, days]);
  const groups = useMemo(
    () => groupPeople(data?.people ?? [], tiers.data ?? [], me.id),
    [data, tiers.data, me.id],
  );
  const shiftsByDay = useMemo(() => groupByDay(data?.shifts ?? [], tz), [data, tz]);
  const peopleById = new Map((data?.people ?? []).map((p) => [p.id, p]));

  return (
    <>
      <PageHeader
        title="Team schedule"
        description={`Published shifts for everyone · times in ${zoneLabel(tz)}`}
        actions={
          <WeekNav
            start={weekStart}
            end={weekEnd}
            onPrev={() => setWeekStart(addDays(weekStart, -7))}
            onNext={() => setWeekStart(addDays(weekStart, 7))}
            onToday={() => setWeekStart(thisWeek)}
            isCurrent={weekStart === thisWeek}
          />
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-44">
          <Select aria-label="Tier" value={tierId} onChange={(e) => setTierId(e.target.value)}>
            <option value="">All tiers</option>
            {tiers.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.id === me.tierId ? ' (my tier)' : ''}
              </option>
            ))}
          </Select>
        </div>
        {!!teams.data?.length && (
          <div className="w-44">
            <Select aria-label="Team" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">All teams</option>
              {teams.data.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        {schedule.isFetching && !schedule.isLoading && <Spinner className="size-4" />}
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
            description="Try a different tier or team."
          />
        </Card>
      ) : (
        <>
          {/* Desktop / tablet: people × days grid */}
          <Card className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full min-w-[900px] table-fixed border-collapse text-sm">
                <colgroup>
                  <col className="w-52" />
                  {days.map((d) => (
                    <col key={d} />
                  ))}
                </colgroup>
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80">
                    <th
                      scope="col"
                      className="sticky left-0 z-10 bg-slate-50 px-4 py-2.5 text-left text-xs font-semibold text-slate-500"
                    >
                      Person
                    </th>
                    {days.map((d) => (
                      <th
                        key={d}
                        scope="col"
                        className={cx(
                          'px-1.5 py-2 text-center text-xs font-semibold',
                          d === today ? 'text-indigo-700' : 'text-slate-500',
                        )}
                      >
                        <span className="block uppercase">
                          {DateTime.fromISO(d).toFormat('ccc')}
                        </span>
                        <span
                          className={cx(
                            'mt-0.5 inline-flex size-7 items-center justify-center rounded-full text-sm',
                            d === today ? 'bg-indigo-600 text-white' : 'text-slate-800',
                          )}
                        >
                          {DateTime.fromISO(d).day}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <GroupRows
                      key={group.key}
                      group={group}
                      days={days}
                      today={today}
                      tz={tz}
                      meId={me.id}
                      byUserDay={byUserDay}
                      offByUserDay={offByUserDay}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Phones: agenda by day */}
          <div className="space-y-4 md:hidden">
            {days.map((day) => (
              <DayAgenda
                key={day}
                day={day}
                today={today}
                tz={tz}
                meId={me.id}
                shifts={shiftsByDay.get(day) ?? []}
                peopleById={peopleById}
                offPeople={(data?.people ?? []).filter((p) => offByUserDay.get(p.id)?.get(day))}
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

function GroupRows({
  group,
  days,
  today,
  tz,
  meId,
  byUserDay,
  offByUserDay,
}: {
  group: Group;
  days: string[];
  today: string;
  tz: string;
  meId: string;
  byUserDay: Map<string, Map<string, ShiftView[]>>;
  offByUserDay: ReturnType<typeof timeOffByUserDay>;
}) {
  return (
    <>
      <tr className="border-b border-slate-100 bg-white">
        <th
          colSpan={days.length + 1}
          scope="colgroup"
          className="sticky left-0 px-4 pt-3 pb-1.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
        >
          <span className="flex items-center gap-2">
            <ColorDot color={group.tier?.color ?? '#94a3b8'} />
            {group.tier?.name ?? 'Other'}
            <span className="font-normal normal-case text-slate-400">· {group.people.length}</span>
          </span>
        </th>
      </tr>
      {group.people.map((person) => {
        const shiftsByDay = byUserDay.get(person.id);
        const weekShifts = [...(shiftsByDay?.values() ?? [])].flat();
        const isMe = person.id === meId;
        return (
          <tr
            key={person.id}
            className={cx('border-b border-slate-100 last:border-0', isMe && 'bg-indigo-50/40')}
          >
            <th
              scope="row"
              className={cx(
                'sticky left-0 z-10 px-4 py-2 text-left font-normal',
                isMe ? 'bg-indigo-50' : 'bg-white',
              )}
            >
              <div className="flex items-center gap-2.5">
                <Avatar name={person.name} size="sm" />
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium text-slate-900">
                    <span className="truncate">{person.name}</span>
                    {isMe && <Badge tone="indigo">You</Badge>}
                  </p>
                  <p className="text-xs text-slate-500">
                    {weekShifts.length ? formatHours(totalHours(weekShifts)) : 'Off this week'}
                  </p>
                </div>
              </div>
            </th>
            {days.map((day) => {
              const shifts = shiftsByDay?.get(day) ?? [];
              const off = offByUserDay.get(person.id)?.get(day);
              return (
                <td
                  key={day}
                  className={cx(
                    'h-16 border-l border-slate-100 p-1 align-top',
                    day === today && 'bg-indigo-50/30',
                    isWeekend(day) && day !== today && 'bg-slate-50/50',
                  )}
                >
                  <div className="space-y-1">
                    {off && <TimeOffChip entry={off} compact />}
                    {shifts.map((s) => (
                      <ShiftChip
                        key={s.id}
                        shift={s}
                        tz={tz}
                        color={s.label?.color ?? s.tier.color}
                        labelName={
                          s.label?.name ?? (s.tier.name !== group.tier?.name ? s.tier.name : null)
                        }
                        status={s.status}
                        mine={isMe}
                      />
                    ))}
                  </div>
                </td>
              );
            })}
          </tr>
        );
      })}
    </>
  );
}

function DayAgenda({
  day,
  today,
  tz,
  meId,
  shifts,
  peopleById,
  offPeople,
}: {
  day: string;
  today: string;
  tz: string;
  meId: string;
  shifts: ShiftView[];
  peopleById: Map<string, PersonRow>;
  offPeople: PersonRow[];
}) {
  return (
    <Card>
      <div
        className={cx(
          'flex items-center justify-between border-b border-slate-100 px-4 py-2.5',
          day === today && 'bg-indigo-50',
        )}
      >
        <p
          className={cx(
            'text-sm font-semibold',
            day === today ? 'text-indigo-700' : 'text-slate-800',
          )}
        >
          {formatDay(day)} {day === today && <span className="font-normal">· Today</span>}
        </p>
        <span className="text-xs text-slate-500">
          {shifts.length} shift{shifts.length === 1 ? '' : 's'}
        </span>
      </div>
      {shifts.length === 0 && offPeople.length === 0 ? (
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
                  s.userId === meId && 'bg-indigo-50/50',
                )}
              >
                <span
                  className="h-8 w-1 shrink-0 rounded-full"
                  style={{ backgroundColor: s.label?.color ?? s.tier.color }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">
                    {person?.name ?? 'Someone'}{' '}
                    {s.userId === meId && <Badge tone="indigo">You</Badge>}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {formatTimeRange(s.startTime, s.endTime, tz)} ·{' '}
                    {[s.label?.name, s.tier.name].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <Badge tone={s.status === 'confirmed' ? 'green' : 'amber'}>
                  {s.status === 'confirmed' ? 'Confirmed' : 'Pending'}
                </Badge>
              </li>
            );
          })}
          {offPeople.map((p) => (
            <li
              key={p.id}
              className="stripes flex items-center gap-3 px-4 py-2 text-sm text-slate-600"
            >
              <Avatar name={p.name} size="sm" /> {p.name} · off
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
