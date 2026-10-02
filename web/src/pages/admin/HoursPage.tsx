import { overtimeReasons, weeklyHours, type WeekTotal } from '@shared/overtime';
import {
  addDays,
  formatDateRange,
  formatDay,
  formatHours,
  startOfWeek,
  todayIn,
  type ISODate,
} from '@shared/time';
import type { OrgSettings, PersonRow, Tier } from '@shared/types';
import { AlarmClock, CalendarCheck, Timer, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useSettings, useTeamSchedule, useTiers } from '../../api/queries';
import { CalendarNav, GroupRows, TierFilter } from '../../components/schedule/CalendarBits';
import {
  Avatar,
  Badge,
  Card,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  Tabs,
} from '../../components/ui/Misc';
import { cx } from '../../lib/cx';
import { overtimeRules } from '../../lib/overtime';
import { breakMinutesByUser, groupByTier, withBreaks } from '../../lib/schedule';
import { useBootstrapData } from '../../lib/session';

const PERIODS = ['1', '2', '4'] as const;
type Period = (typeof PERIODS)[number];
const NO_TIERS: Tier[] = [];

interface PersonHours {
  person: PersonRow;
  /** By the week's first day. */
  weeks: Map<ISODate, WeekTotal>;
  hours: number;
  overtime: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

function limitsText(settings: OrgSettings | undefined): string | null {
  const parts = [
    settings?.overtimeDailyHours && `${formatHours(settings.overtimeDailyHours)} a day`,
    settings?.overtimeWeeklyHours && `${formatHours(settings.overtimeWeeklyHours)} a week`,
  ].filter(Boolean);
  return parts.length ? parts.join(' or ') : null;
}

/** Published hours per person and week, with overtime past the limits in Settings. */
export default function HoursPage() {
  const { org } = useBootstrapData();
  // Days and weeks are the organization's, as in the builder.
  const tz = org.timezone;
  const today = todayIn(tz);
  const [params, setParams] = useSearchParams();
  const period: Period = PERIODS.find((p) => p === params.get('weeks')) ?? '1';
  const weekCount = Number(period);
  const from = startOfWeek(params.get('date') ?? today, org.weekStartsOn);
  const to = addDays(from, weekCount * 7 - 1);
  const tierFilter = params.get('tiers')?.split(',').filter(Boolean) ?? [];
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // The team schedule's days are the viewer's, which can be a few hours off
  // the organization's: a day either side catches the shifts at the edges
  // (weeks outside the range are dropped below).
  const schedule = useTeamSchedule(addDays(from, -1), addDays(to, 1));
  const tiers = useTiers();
  const settings = useSettings();
  const rules = overtimeRules(settings.data);
  const limits = limitsText(settings.data);

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

  const header = (
    <PageHeader
      title="Hours"
      description={
        <>
          Published shifts per person.{' '}
          {limits ? `Overtime is past ${limits}` : 'Overtime isn’t flagged'} (
          <Link to="/admin/settings" className="font-medium text-brand-600 hover:underline">
            change in Settings
          </Link>
          ).
        </>
      }
    />
  );
  if (schedule.isError) {
    return (
      <>
        {header}
        <ErrorBlock error={schedule.error} onRetry={() => void schedule.refetch()} />
      </>
    );
  }

  const weekStarts = Array.from({ length: weekCount }, (_, i) => addDays(from, i * 7));
  const data = schedule.data;
  const people = (data?.people ?? []).filter(
    (p) => tierFilter.length === 0 || (p.tierId !== null && tierFilter.includes(p.tierId)),
  );
  // Paid hours: each person's tier can take an unpaid break (lunch) off their longer shifts.
  const breaks = breakMinutesByUser(data?.people ?? [], tiers.data ?? NO_TIERS);
  const rows = new Map<string, PersonHours>(
    people.map((person) => {
      const shifts = withBreaks(
        (data?.shifts ?? []).filter((s) => s.userId === person.id),
        breaks,
      );
      const weeks = new Map(
        weeklyHours(shifts, tz, org.weekStartsOn, rules)
          // A shift that started the night before the first day belongs to the week before.
          .filter((w) => weekStarts.includes(w.start))
          .map((w) => [w.start, w]),
      );
      const counted = [...weeks.values()];
      return [
        person.id,
        {
          person,
          weeks,
          hours: round(counted.reduce((n, w) => n + w.hours, 0)),
          overtime: round(counted.reduce((n, w) => n + w.overtime, 0)),
        },
      ];
    }),
  );
  const all = [...rows.values()];
  const totalHours = round(all.reduce((n, r) => n + r.hours, 0));
  const totalOvertime = round(all.reduce((n, r) => n + r.overtime, 0));
  const overtimePeople = all.filter((r) => r.overtime > 0).length;
  const scheduled = all.filter((r) => r.hours > 0).length;
  const groups = groupByTier(people, tiers.data ?? NO_TIERS);
  const columns = 2 + weekCount + (weekCount > 1 ? 1 : 0);
  const sumWeek = (list: PersonHours[], week: ISODate) =>
    round(list.reduce((n, r) => n + (r.weeks.get(week)?.hours ?? 0), 0));

  return (
    <>
      {header}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <CalendarNav
          label={formatDateRange(from, to)}
          onPrev={() => update({ date: addDays(from, -7 * weekCount) })}
          onNext={() => update({ date: addDays(from, 7 * weekCount) })}
          onToday={() => update({ date: null })}
          isCurrent={from === startOfWeek(today, org.weekStartsOn)}
          value={from}
          onPick={(date) => update({ date })}
        />
        <Tabs
          value={period}
          onChange={(p) => update({ weeks: p === '1' ? null : p })}
          options={[
            { value: '1', label: 'Week' },
            { value: '2', label: '2 weeks' },
            { value: '4', label: '4 weeks' },
          ]}
        />
      </div>
      <div className="mb-4">
        <TierFilter
          tiers={tiers.data ?? NO_TIERS}
          selected={tierFilter}
          onChange={(ids) => update({ tiers: ids.length ? ids.join(',') : null })}
        />
      </div>

      {!data ? (
        <LoadingBlock />
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <Stat icon={<Timer />} value={formatHours(totalHours)} label="Scheduled" />
            <Stat
              icon={<AlarmClock />}
              value={formatHours(totalOvertime)}
              label={
                overtimePeople
                  ? `Overtime, ${overtimePeople} ${overtimePeople === 1 ? 'person' : 'people'}`
                  : 'Overtime'
              }
              warn={totalOvertime > 0}
            />
            <Stat
              icon={<Users />}
              value={`${scheduled} of ${people.length}`}
              label="People with shifts"
            />
          </div>

          <Card className="overflow-hidden">
            {people.length === 0 ? (
              <EmptyState
                icon={<CalendarCheck />}
                title="No one to show"
                description="People in a tier, and anyone with a published shift, appear here."
              />
            ) : (
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full min-w-[34rem] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-500">
                      <th scope="col" className="px-4 py-2.5 text-left">
                        Person
                      </th>
                      {weekStarts.map((week) => (
                        <th key={week} scope="col" className="px-3 py-2.5 text-right">
                          {weekCount === 1 ? 'Hours' : `Week of ${formatDay(week)}`}
                        </th>
                      ))}
                      {weekCount > 1 && (
                        <th scope="col" className="px-3 py-2.5 text-right">
                          Total
                        </th>
                      )}
                      <th scope="col" className="px-4 py-2.5 text-right">
                        Overtime
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((group) => {
                      const members = group.people.map((p) => rows.get(p.id)!);
                      const isCollapsed = collapsed.has(group.key);
                      return (
                        <GroupRows
                          key={group.key}
                          label={group.tier?.name ?? 'No tier'}
                          color={group.tier?.color ?? 'var(--color-slate-400)'}
                          count={group.people.length}
                          hours={formatHours(round(members.reduce((n, r) => n + r.hours, 0)))}
                          colSpan={columns}
                          collapsed={isCollapsed}
                          onToggle={() =>
                            setCollapsed((c) => {
                              const next = new Set(c);
                              if (next.has(group.key)) next.delete(group.key);
                              else next.add(group.key);
                              return next;
                            })
                          }
                        >
                          {!isCollapsed &&
                            members.map((row) => (
                              <tr key={row.person.id} className="border-b border-slate-100">
                                <th scope="row" className="px-4 py-2.5 text-left font-normal">
                                  <div className="flex items-center gap-2.5">
                                    <Avatar name={row.person.name} size="sm" />
                                    <div className="min-w-0">
                                      <p className="truncate font-medium text-slate-900">
                                        {row.person.name}
                                      </p>
                                      {!row.person.active && (
                                        <p className="text-xs text-slate-500">Deactivated</p>
                                      )}
                                    </div>
                                  </div>
                                </th>
                                {weekStarts.map((week) => {
                                  const total = row.weeks.get(week);
                                  const why = total
                                    ? overtimeReasons(total, rules, formatDay, formatHours)
                                    : [];
                                  return (
                                    <td
                                      key={week}
                                      className="px-3 py-2.5 text-right tabular-nums text-slate-700"
                                    >
                                      {total ? formatHours(total.hours) : '—'}
                                      {total && total.overtime > 0 && (
                                        <span title={why.join('\n')} className="ml-2">
                                          <Badge tone="amber" className="px-1.5 py-0 text-[11px]">
                                            {formatHours(total.overtime)} OT
                                          </Badge>
                                        </span>
                                      )}
                                    </td>
                                  );
                                })}
                                {weekCount > 1 && (
                                  <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-900">
                                    {row.hours ? formatHours(row.hours) : '—'}
                                  </td>
                                )}
                                <td
                                  className={cx(
                                    'px-4 py-2.5 text-right tabular-nums',
                                    row.overtime > 0
                                      ? 'font-semibold text-amber-700'
                                      : 'text-slate-400',
                                  )}
                                >
                                  {row.overtime > 0 ? formatHours(row.overtime) : '—'}
                                </td>
                              </tr>
                            ))}
                        </GroupRows>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-50/70 font-semibold text-slate-900">
                      <th scope="row" className="px-4 py-2.5 text-left">
                        Total
                      </th>
                      {weekStarts.map((week) => (
                        <td key={week} className="px-3 py-2.5 text-right tabular-nums">
                          {formatHours(sumWeek(all, week))}
                        </td>
                      ))}
                      {weekCount > 1 && (
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {formatHours(totalHours)}
                        </td>
                      )}
                      <td
                        className={cx(
                          'px-4 py-2.5 text-right tabular-nums',
                          totalOvertime > 0 && 'text-amber-700',
                        )}
                      >
                        {totalOvertime > 0 ? formatHours(totalOvertime) : '—'}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Card>
          <p className="mt-3 text-xs text-slate-500">
            Drafts aren’t counted until they’re published; the schedule builder flags overtime in
            drafts. A shift counts toward the day it starts.
          </p>
        </>
      )}
    </>
  );
}

function Stat({
  icon,
  value,
  label,
  warn = false,
}: {
  icon: ReactNode;
  value: string;
  label: string;
  warn?: boolean;
}) {
  return (
    <div className="glass underglow flex items-center gap-3 rounded-2xl p-4 ring-1 ring-slate-200/80">
      <span
        className={cx(
          'rounded-lg p-2 [&>svg]:size-5',
          warn ? 'bg-amber-50 text-amber-600' : 'bg-brand-50 text-brand-600',
        )}
      >
        {icon}
      </span>
      <div>
        <p className="text-xl font-bold tabular-nums text-slate-900">{value}</p>
        <p className="text-sm text-slate-500">{label}</p>
      </div>
    </div>
  );
}
