import { formatDateRange, formatDay, formatTimeRange, localDate } from '@shared/time';
import type { ScheduleSummary, UnconfirmedShift } from '@shared/types';
import { DateTime } from 'luxon';
import {
  CalendarClock,
  CalendarPlus,
  ChevronRight,
  CircleAlert,
  MailWarning,
  Plane,
  Sparkles,
  UserPlus,
  UserRoundX,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useOverview } from '../../api/queries';
import { ActivityLine } from '../../components/ActivityLine';
import { ConfirmationBar } from '../../components/schedule/ConfirmationBar';
import { StatusBadge } from '../../components/schedule/StatusBadge';
import { ButtonLink } from '../../components/ui/Button';
import {
  Avatar,
  Card,
  CardHeader,
  ColorDot,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
} from '../../components/ui/Misc';
import { cx } from '../../lib/cx';
import { scheduleTitle } from '../../lib/schedule';
import { useBootstrapData, useCurrentUser } from '../../lib/session';

function greeting(tz: string): string {
  const hour = DateTime.now().setZone(tz).hour;
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

function Stat({
  to,
  icon,
  value,
  label,
  tone,
}: {
  to: string;
  icon: ReactNode;
  value: number;
  label: string;
  tone: 'indigo' | 'amber' | 'red' | 'slate';
}) {
  const tones = {
    indigo: 'bg-indigo-50 text-indigo-600',
    amber: 'bg-amber-50 text-amber-600',
    red: 'bg-rose-50 text-rose-600',
    slate: 'bg-slate-100 text-slate-500',
  };
  const className =
    'group rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200 transition hover:ring-indigo-300';
  const body = (
    <>
      <div className="flex items-center justify-between">
        <span className={cx('rounded-lg p-2 [&>svg]:size-5', tones[tone])}>{icon}</span>
        <ChevronRight className="size-4 text-slate-300 group-hover:text-indigo-500" />
      </div>
      <p className="mt-3 text-2xl font-bold tabular-nums text-slate-900">{value}</p>
      <p className="text-sm text-slate-500">{label}</p>
    </>
  );
  return to.startsWith('#') ? (
    <a href={to} className={className}>
      {body}
    </a>
  ) : (
    <Link to={to} className={className}>
      {body}
    </Link>
  );
}

function ScheduleLine({ schedule, action }: { schedule: ScheduleSummary; action: string }) {
  return (
    <li>
      <Link
        to={`/admin/schedules/${schedule.id}`}
        className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50"
      >
        <ColorDot color={schedule.tierColor} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-900">
            {schedule.tierName} · {scheduleTitle(schedule)}
          </p>
          <div className="mt-0.5">
            <StatusBadge schedule={schedule} />
          </div>
        </div>
        <span className="text-sm font-semibold text-indigo-600">{action}</span>
      </Link>
    </li>
  );
}

export default function DashboardPage() {
  const user = useCurrentUser();
  const { org } = useBootstrapData();
  const tz = user.timezone ?? org.timezone;
  const overview = useOverview();

  if (overview.isLoading) return <LoadingBlock />;
  if (overview.isError || !overview.data)
    return <ErrorBlock error={overview.error} onRetry={() => void overview.refetch()} />;
  const o = overview.data;
  const attention = [...o.drafts, ...o.withChanges];
  const grouped = new Map<string, UnconfirmedShift[]>();
  for (const s of o.unconfirmedSoon) grouped.set(s.userId, [...(grouped.get(s.userId) ?? []), s]);
  const unconfirmedByPerson = [...grouped.values()].map((shifts) => ({
    userName: shifts[0]!.userName,
    shifts,
  }));

  return (
    <>
      <PageHeader
        title={`${greeting(tz)}, ${user.name.split(' ')[0]}`}
        description={`Here's what's happening at ${org.name}.`}
        actions={
          <>
            <ButtonLink to="/admin/people?invite=1" icon={<UserPlus className="size-4" />}>
              Invite people
            </ButtonLink>
            <ButtonLink
              to="/admin/schedules?new=1"
              variant="primary"
              icon={<CalendarPlus className="size-4" />}
            >
              New schedule
            </ButtonLink>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          to="/admin/time-off"
          icon={<Plane />}
          value={o.pendingTimeOff}
          label="Time-off requests to review"
          tone={o.pendingTimeOff ? 'indigo' : 'slate'}
        />
        <Stat
          to="#unconfirmed"
          icon={<CalendarClock />}
          value={o.unconfirmedSoon.length}
          label="Unconfirmed shifts, next 7 days"
          tone={o.unconfirmedSoon.length ? 'amber' : 'slate'}
        />
        <Stat
          to="/admin/people"
          icon={<UserRoundX />}
          value={o.invitedPeople}
          label="Invites not accepted yet"
          tone="slate"
        />
        <Stat
          to="/admin/activity?tab=emails"
          icon={<MailWarning />}
          value={o.failedEmails}
          label="Emails that failed (7 days)"
          tone={o.failedEmails ? 'red' : 'slate'}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Needs your attention"
              description="Drafts and unpublished changes the team can't see yet."
            />
            {attention.length === 0 && o.peopleWithoutTier === 0 ? (
              <EmptyState
                icon={<Sparkles />}
                title="You're all caught up"
                description="Every schedule is published."
              />
            ) : (
              <ul className="divide-y divide-slate-100">
                {o.drafts.map((s) => (
                  <ScheduleLine key={s.id} schedule={s} action="Finish & publish" />
                ))}
                {o.withChanges.map((s) => (
                  <ScheduleLine key={s.id} schedule={s} action="Review changes" />
                ))}
                {o.peopleWithoutTier > 0 && (
                  <li>
                    <Link
                      to="/admin/people"
                      className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50"
                    >
                      <CircleAlert className="size-4 text-amber-500" />
                      <p className="flex-1 text-sm text-slate-700">
                        {o.peopleWithoutTier}{' '}
                        {o.peopleWithoutTier === 1 ? 'person has' : 'people have'} no tier yet
                      </p>
                      <span className="text-sm font-semibold text-indigo-600">Assign</span>
                    </Link>
                  </li>
                )}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Published schedules"
              description="Confirmation progress for current and upcoming schedules."
            />
            {o.upcoming.length === 0 ? (
              <EmptyState
                title="Nothing published yet"
                description="Published schedules and their confirmations appear here."
              />
            ) : (
              <ul className="divide-y divide-slate-100">
                {o.upcoming.map((s) => (
                  <li key={s.id}>
                    <Link
                      to={`/admin/schedules/${s.id}`}
                      className="flex flex-wrap items-center gap-3 px-5 py-3 hover:bg-slate-50"
                    >
                      <ColorDot color={s.tierColor} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-900">{s.tierName}</p>
                        <p className="text-xs text-slate-500">
                          {formatDateRange(s.startDate, s.endDate)}
                        </p>
                      </div>
                      <ConfirmationBar
                        confirmed={s.confirmedCount}
                        total={s.confirmedCount + s.pendingCount}
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <div id="unconfirmed" className="scroll-mt-20" />
            <CardHeader
              title="Waiting for confirmation (next 7 days)"
              description="People get an automatic reminder if they haven't confirmed."
            />
            {unconfirmedByPerson.length === 0 ? (
              <EmptyState
                title="Everyone has confirmed"
                description="No upcoming shifts are waiting for confirmation."
              />
            ) : (
              <ul className="divide-y divide-slate-100">
                {unconfirmedByPerson.slice(0, 12).map(({ userName, shifts }) => {
                  const next = shifts[0]!;
                  return (
                    <li key={next.userId} className="flex items-center gap-3 px-5 py-2.5">
                      <Avatar name={userName} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-900">{userName}</p>
                        <p className="truncate text-xs text-slate-500">
                          Next: {formatDay(localDate(next.startTime, tz))} ·{' '}
                          {formatTimeRange(next.startTime, next.endTime, tz)}
                        </p>
                      </div>
                      <span className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-amber-700">
                        {[...new Map(shifts.map((s) => [s.tier.id, s.tier])).values()].map((t) => (
                          <ColorDot key={t.id} color={t.color} />
                        ))}
                        {shifts.length} unconfirmed
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {unconfirmedByPerson.length > 12 && (
              <p className="px-5 pb-3 text-xs text-slate-500">
                …and {unconfirmedByPerson.length - 12} more people.
              </p>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Recent activity"
              actions={
                <Link
                  to="/admin/activity"
                  className="text-sm font-semibold text-indigo-600 hover:text-indigo-500"
                >
                  View all
                </Link>
              }
            />
            {o.recentActivity.length === 0 ? (
              <EmptyState title="No activity yet" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {o.recentActivity.map((a) => (
                  <ActivityLine key={a.id} entry={a} tz={tz} />
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
