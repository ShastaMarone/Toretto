import { holidaysBetween } from '@shared/holidays';
import {
  addDays,
  formatDateRange,
  formatDay,
  formatTimeRange,
  localDate,
  todayIn,
} from '@shared/time';
import type { ScheduleSummary, UnconfirmedShift } from '@shared/types';
import { DateTime } from 'luxon';
import {
  CalendarClock,
  CalendarDays,
  ChevronRight,
  CircleAlert,
  Leaf,
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
  tone: 'brand' | 'amber' | 'red' | 'slate';
}) {
  const tones = {
    brand: 'bg-brand-50 text-brand-600',
    amber: 'bg-amber-50 text-amber-600',
    red: 'bg-rose-50 text-rose-600',
    slate: 'bg-slate-100 text-slate-500',
  };
  const className =
    'glass underglow group rounded-2xl p-4 ring-1 ring-slate-200/80 transition hover:-translate-y-0.5 hover:ring-brand-300 dark:hover:ring-brand-400/50';
  const body = (
    <>
      <div className="flex items-center justify-between">
        <span className={cx('rounded-lg p-2 [&>svg]:size-5', tones[tone])}>{icon}</span>
        <ChevronRight className="size-4 text-slate-300 group-hover:text-brand-500" />
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

function ScheduleLine({ schedule }: { schedule: ScheduleSummary }) {
  const range =
    schedule.firstChangeDate && schedule.lastChangeDate
      ? formatDateRange(schedule.firstChangeDate, schedule.lastChangeDate)
      : null;
  return (
    <li>
      <Link
        to={`/admin/schedules/${schedule.id}${schedule.firstChangeDate ? `?date=${schedule.firstChangeDate}` : ''}`}
        className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50"
      >
        <span className="neon bg-neon size-2.5 shrink-0 rounded-full" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-900">{schedule.name}</p>
          <p className="text-xs text-slate-500">
            {schedule.pendingChanges} unpublished change
            {schedule.pendingChanges === 1 ? '' : 's'}
            {range && ` · ${range}`}
          </p>
        </div>
        <span className="text-sm font-semibold text-brand-600">Review & publish</span>
      </Link>
    </li>
  );
}

export default function DashboardPage() {
  const user = useCurrentUser();
  const { org, devMailbox, emailConfigured } = useBootstrapData();
  const tz = user.timezone ?? org.timezone;
  const overview = useOverview();

  if (overview.isLoading) return <LoadingBlock />;
  if (overview.isError || !overview.data)
    return <ErrorBlock error={overview.error} onRetry={() => void overview.refetch()} />;
  const o = overview.data;
  const attention = o.schedules.filter((s) => s.pendingChanges > 0);
  const today = todayIn(org.timezone);
  const nextHolidays = [...holidaysBetween(org.holidayRegion, today, addDays(today, 120)).values()]
    .flat()
    .filter((h) => !h.observed)
    .slice(0, 3);
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
              to="/admin/schedules"
              variant="primary"
              icon={<CalendarDays className="size-4" />}
            >
              Open schedule
            </ButtonLink>
          </>
        }
      />

      {!emailConfigured && !devMailbox && (
        <div className="mb-6 flex gap-3 rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-inset ring-amber-200">
          <MailWarning className="mt-0.5 size-5 shrink-0 text-amber-600" />
          <p>
            <strong>Email isn't set up yet.</strong> Invites, schedule notifications and reminders
            are only written to the server log, so nobody receives them. Set{' '}
            <code className="font-mono text-xs">EMAIL_TRANSPORT</code> and your email provider's key
            in the server's environment variables.
          </p>
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          to="/admin/time-off"
          icon={<Plane />}
          value={o.pendingTimeOff}
          label="Time-off requests to review"
          tone={o.pendingTimeOff ? 'brand' : 'slate'}
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
              description="Unpublished changes the team can't see yet."
            />
            {attention.length === 0 && o.peopleWithoutTier === 0 ? (
              <EmptyState
                icon={<Sparkles />}
                title="You're all caught up"
                description="Everything on the schedule is published."
              />
            ) : (
              <ul className="divide-y divide-slate-100">
                {attention.map((s) => (
                  <ScheduleLine key={s.id} schedule={s} />
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
                      <span className="text-sm font-semibold text-brand-600">Assign</span>
                    </Link>
                  </li>
                )}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Confirmations" description="Published shifts confirmed, by week." />
            <ul className="divide-y divide-slate-100">
              {o.weeks.map((w, i) => (
                <li key={w.startDate}>
                  <Link
                    to={`/admin/schedules/${o.schedules.find((s) => s.isDefault)?.id ?? ''}?date=${w.startDate}`}
                    className="flex flex-wrap items-center gap-3 px-5 py-3 hover:bg-slate-50"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-900">
                        {i === 0
                          ? 'This week'
                          : i === 1
                            ? 'Next week'
                            : formatDateRange(w.startDate, w.endDate)}
                      </p>
                      {i < 2 && (
                        <p className="text-xs text-slate-500">
                          {formatDateRange(w.startDate, w.endDate)}
                        </p>
                      )}
                    </div>
                    {w.total ? (
                      <ConfirmationBar confirmed={w.confirmed} total={w.total} />
                    ) : (
                      <span className="text-xs text-slate-400">Nothing published</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>

          {nextHolidays.length > 0 && (
            <Card>
              <CardHeader
                title="Upcoming holidays"
                description="Statutory holidays for your region (Settings)."
              />
              <ul className="divide-y divide-slate-100">
                {nextHolidays.map((h) => (
                  <li key={h.date + h.name} className="flex items-center gap-3 px-5 py-2.5">
                    <span className="rounded-lg bg-rose-50 p-1.5 text-rose-600 ring-1 ring-inset ring-rose-200">
                      <Leaf className="size-4" />
                    </span>
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
                      {h.name}
                    </p>
                    <span className="text-xs text-slate-500">{formatDay(h.date)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
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
                        {[
                          ...new Map(
                            shifts.flatMap((s) => (s.tier ? [[s.tier.id, s.tier] as const] : [])),
                          ).values(),
                        ].map((t) => (
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
                  className="text-sm font-semibold text-brand-600 hover:text-brand-500"
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
