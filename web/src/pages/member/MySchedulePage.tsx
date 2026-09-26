import {
  addDays,
  addMonths,
  dayOfWeek,
  eachDay,
  endOfMonth,
  formatDay,
  formatTimeRange,
  formatTimeRangeCompact,
  localDate,
  startOfMonth,
  startOfWeek,
  todayIn,
  type ISODate,
} from '@shared/time';
import { formatTimeOffWhen, timeOffDays, timeOffLength } from '@shared/timeOff';
import type { ShiftSwap, ShiftView, TimeOffRequest } from '@shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import {
  CalendarCheck,
  CalendarPlus,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Leaf,
  Plane,
  Plus,
  Repeat,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { useMyShifts, useMySwaps, useMyTimeOff } from '../../api/queries';
import { CalendarFeedPanel } from '../../components/CalendarFeed';
import { HolidayBadge } from '../../components/schedule/CalendarBits';
import { ShiftChip, StatusIcon } from '../../components/schedule/ShiftChip';
import { OpenShiftsCard } from '../../components/swaps/OpenShiftsCard';
import { SwapDialog } from '../../components/swaps/SwapDialog';
import { SwapsCard } from '../../components/swaps/SwapsCard';
import { TimeOffRequestDialog } from '../../components/TimeOffRequestDialog';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import {
  Badge,
  Card,
  CardHeader,
  ColorDot,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  type Tone,
} from '../../components/ui/Misc';
import { cx } from '../../lib/cx';
import { useHolidays } from '../../lib/holidays';
import { groupByDay, shiftColor } from '../../lib/schedule';
import { useBootstrapData, useCurrentUser, useTimeFormat, useViewerZone } from '../../lib/session';
import { firstName, isOpenSwap, swapStatus } from '../../lib/swaps';
import { zoneLabel } from '../../lib/timezones';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { useNow } from '../../lib/useNow';

const STATUS: Record<TimeOffRequest['status'], { label: string; tone: Tone }> = {
  pending: { label: 'Waiting for approval', tone: 'amber' },
  approved: { label: 'Approved', tone: 'green' },
  denied: { label: 'Declined', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
};

function useConfirmShifts() {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['my-shifts'] });
    void queryClient.invalidateQueries({ queryKey: ['team'] });
  };
  const one = useMutation({
    mutationFn: (id: string) => api.post<ShiftView>(`/my/shifts/${id}/confirm`),
    onSuccess: () => {
      toast.success('Shift confirmed');
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const all = useMutation({
    mutationFn: () => api.post<{ confirmed: number }>('/my/shifts/confirm', {}),
    onSuccess: ({ confirmed }) => {
      toast.success(`Confirmed ${confirmed} shift${confirmed === 1 ? '' : 's'}`);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  return { one, all };
}

export default function MySchedulePage() {
  const { org } = useBootstrapData();
  const me = useCurrentUser();
  const tz = useViewerZone();
  const timeFormat = useTimeFormat();
  const today = todayIn(tz);
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [month, setMonth] = useState(startOfMonth(today));
  const [requestFor, setRequestFor] = useState<ISODate | null>(null);
  const [dayOpen, setDayOpen] = useState<ISODate | null>(null);
  const [shiftOpen, setShiftOpen] = useState<ShiftView | null>(null);
  const [cancelling, setCancelling] = useState<TimeOffRequest | null>(null);
  const [addingCalendar, setAddingCalendar] = useState(false);
  const [offering, setOffering] = useState<ShiftView | null>(null);
  const swaps = useMySwaps();
  const openSwapFor = (shiftId: string) =>
    swaps.data?.find(
      (w) => isOpenSwap(w) && (w.shift.id === shiftId || w.returnShift?.id === shiftId),
    );
  const queryClient = useQueryClient();

  const gridStart = startOfWeek(month, org.weekStartsOn);
  const gridEnd = addDays(startOfWeek(endOfMonth(month), org.weekStartsOn), 6);
  const monthShifts = useMyShifts(gridStart, gridEnd);
  const holidays = useHolidays(gridStart, gridEnd);
  const upcoming = useMyShifts(today, addDays(today, 60));
  const timeOff = useMyTimeOff();
  const { one: confirmOne, all: confirmAll } = useConfirmShifts();

  const cancel = useMutation({
    mutationFn: (id: string) => api.post<TimeOffRequest>(`/my/time-off/${id}/cancel`),
    onSuccess: () => {
      toast.success('Time off cancelled');
      setCancelling(null);
      void queryClient.invalidateQueries({ queryKey: ['my-time-off'] });
    },
    onError: (e) => toast.error(e.message),
  });

  const now = useNow();
  const needsConfirmation = (upcoming.data ?? []).filter(
    (s) => s.status === 'pending' && Date.parse(s.endTime) > now,
  );
  const next14 = (upcoming.data ?? []).filter(
    (s) => localDate(s.startTime, tz) <= addDays(today, 13),
  );
  const shiftsByDay = useMemo(() => groupByDay(monthShifts.data ?? [], tz), [monthShifts.data, tz]);
  const activeTimeOff = (timeOff.data ?? []).filter(
    (r) => r.status === 'pending' || r.status === 'approved',
  );
  const timeOffOn = (day: ISODate) => activeTimeOff.filter((r) => timeOffDays(r, tz).includes(day));

  const onDayClick = (day: ISODate) => (isDesktop ? setRequestFor(day) : setDayOpen(day));

  return (
    <>
      <PageHeader
        title="My schedule"
        description={`Times shown in ${zoneLabel(tz)}`}
        actions={
          <>
            <Button
              icon={<CalendarPlus className="size-4" />}
              onClick={() => setAddingCalendar(true)}
            >
              Add to calendar
            </Button>
            <Button
              variant="primary"
              icon={<Plane className="size-4" />}
              onClick={() => setRequestFor(today)}
            >
              Request time off
            </Button>
          </>
        }
      />

      {needsConfirmation.length > 0 && (
        <Card className="mb-6 overflow-hidden ring-amber-200">
          <div className="flex flex-wrap items-center justify-between gap-3 bg-amber-50 px-5 py-3">
            <div>
              <p className="text-sm font-semibold text-amber-900">
                {needsConfirmation.length} shift{needsConfirmation.length === 1 ? '' : 's'} waiting
                for your confirmation
              </p>
              <p className="text-xs text-amber-800">
                Let your admin know you've seen your schedule.
              </p>
            </div>
            {needsConfirmation.length > 1 && (
              <Button
                variant="success"
                size="sm"
                icon={<CheckCheck className="size-4" />}
                loading={confirmAll.isPending}
                onClick={() => confirmAll.mutate()}
              >
                Confirm all {needsConfirmation.length}
              </Button>
            )}
          </div>
          <ul className="divide-y divide-slate-100">
            {needsConfirmation.slice(0, 8).map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className="h-9 w-1 rounded-full" style={{ backgroundColor: shiftColor(s) }} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-900">
                    {formatDay(localDate(s.startTime, tz))} ·{' '}
                    {formatTimeRange(s.startTime, s.endTime, tz, { format: timeFormat })}
                  </p>
                  <p className="text-xs text-slate-500">
                    {[s.label?.name, s.notes].filter(Boolean).join(' · ') || s.scheduleName}
                  </p>
                </div>
                <Button
                  size="sm"
                  icon={<CalendarCheck className="size-4" />}
                  loading={confirmOne.isPending && confirmOne.variables === s.id}
                  onClick={() => confirmOne.mutate(s.id)}
                >
                  Confirm
                </Button>
              </li>
            ))}
          </ul>
          {needsConfirmation.length > 8 && (
            <p className="px-5 pb-3 text-xs text-slate-500">
              …and {needsConfirmation.length - 8} more.
            </p>
          )}
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5">
            <h2 className="text-base font-semibold text-slate-900">
              {DateTime.fromISO(month).toFormat('LLLL yyyy')}
            </h2>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => setMonth(startOfMonth(today))}
                disabled={month === startOfMonth(today)}
              >
                Today
              </Button>
              <Button
                size="icon-sm"
                aria-label="Previous month"
                onClick={() => setMonth(addMonths(month, -1))}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                size="icon-sm"
                aria-label="Next month"
                onClick={() => setMonth(addMonths(month, 1))}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
          {monthShifts.isError ? (
            <ErrorBlock error={monthShifts.error} onRetry={() => void monthShifts.refetch()} />
          ) : (
            <MonthGrid
              days={eachDay(gridStart, gridEnd)}
              month={month}
              today={today}
              tz={tz}
              shiftsByDay={shiftsByDay}
              holidays={holidays}
              timeOffOn={timeOffOn}
              compact={!isDesktop}
              onDayClick={onDayClick}
              onShiftClick={setShiftOpen}
            />
          )}
          <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
            {isDesktop
              ? 'Click any day to request time off. Click a shift for details.'
              : 'Tap a day to see shifts or request time off.'}
          </p>
        </Card>

        <div className="space-y-6">
          <SwapsCard tz={tz} />
          <OpenShiftsCard tz={tz} />
          <Card>
            <CardHeader title="Next two weeks" />
            {upcoming.isLoading ? (
              <LoadingBlock />
            ) : next14.length === 0 ? (
              <EmptyState
                icon={<CalendarCheck />}
                title="No shifts in the next two weeks"
                description="Published shifts will show up here."
              />
            ) : (
              <ul className="divide-y divide-slate-100">
                {next14.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setShiftOpen(s)}
                      className="flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-slate-50"
                    >
                      <DateBadge date={localDate(s.startTime, tz)} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-slate-900">
                          {formatTimeRange(s.startTime, s.endTime, tz, { format: timeFormat })}
                        </p>
                        <p className="truncate text-xs text-slate-500">
                          {s.label?.name ?? s.scheduleName}
                        </p>
                      </div>
                      <StatusIcon status={s.status} className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="My time off"
              actions={
                <Button
                  size="sm"
                  icon={<Plus className="size-4" />}
                  onClick={() => setRequestFor(today)}
                >
                  Request
                </Button>
              }
            />
            {timeOff.isLoading ? (
              <LoadingBlock />
            ) : !timeOff.data?.length ? (
              <EmptyState
                icon={<Plane />}
                title="No time off yet"
                description="Paid holidays, personal days, vacation — request them here."
              />
            ) : (
              <ul className="divide-y divide-slate-100">
                {timeOff.data.slice(0, 12).map((r) => {
                  const upcoming = r.endTime ? Date.parse(r.endTime) > now : r.endDate >= today;
                  const canCancel = r.status === 'pending' || (r.status === 'approved' && upcoming);
                  return (
                    <li key={r.id} className="px-5 py-3">
                      <div className="flex items-start gap-3">
                        <ColorDot color={r.type.color} className="mt-1.5" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-slate-900">{r.type.name}</p>
                          <p className="text-xs text-slate-500">
                            {formatTimeOffWhen(r, tz, timeFormat)} · {timeOffLength(r)}
                          </p>
                          {r.reviewNote && (
                            <p className="mt-1 text-xs italic text-slate-600">“{r.reviewNote}”</p>
                          )}
                        </div>
                        <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                      </div>
                      {canCancel && (
                        <div className="mt-1 pl-5">
                          <button
                            type="button"
                            onClick={() => setCancelling(r)}
                            className="text-xs font-semibold text-slate-500 hover:text-rose-600"
                          >
                            {r.status === 'pending' ? 'Withdraw request' : 'Cancel time off'}
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {requestFor && (
        <TimeOffRequestDialog initialDate={requestFor} onClose={() => setRequestFor(null)} />
      )}
      {offering && <SwapDialog shift={offering} tz={tz} onClose={() => setOffering(null)} />}
      {addingCalendar && (
        <Modal
          title="Add your shifts to Google Calendar"
          description="Or to any calendar app that can subscribe to a link."
          onClose={() => setAddingCalendar(false)}
        >
          <CalendarFeedPanel />
        </Modal>
      )}
      {shiftOpen && (
        <ShiftDetailsDialog
          shift={shiftOpen}
          tz={tz}
          swap={openSwapFor(shiftOpen.id)}
          onOffer={
            me.tierId
              ? () => {
                  setOffering(shiftOpen);
                  setShiftOpen(null);
                }
              : undefined
          }
          confirming={confirmOne.isPending}
          onConfirm={() => confirmOne.mutate(shiftOpen.id, { onSuccess: () => setShiftOpen(null) })}
          onClose={() => setShiftOpen(null)}
        />
      )}
      {dayOpen && (
        <Modal title={formatDay(dayOpen, 'long')} onClose={() => setDayOpen(null)}>
          <div className="space-y-3">
            {timeOffOn(dayOpen).map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-sm">
                <Plane className="size-4" style={{ color: r.type.color }} />
                {r.type.name}
                {r.startTime &&
                  r.endTime &&
                  ` · ${formatTimeRange(r.startTime, r.endTime, tz, { format: timeFormat })}`}{' '}
                <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
              </div>
            ))}
            {(shiftsByDay.get(dayOpen) ?? []).map((s) => (
              <ShiftChip
                key={s.id}
                shift={s}
                tz={tz}
                color={shiftColor(s)}
                labelName={s.label?.name}
                status={s.status}
                onClick={() => {
                  setDayOpen(null);
                  setShiftOpen(s);
                }}
              />
            ))}
            {!shiftsByDay.get(dayOpen)?.length && !timeOffOn(dayOpen).length && (
              <p className="text-sm text-slate-500">Nothing scheduled.</p>
            )}
            <Button
              variant="primary"
              className="w-full"
              icon={<Plane className="size-4" />}
              onClick={() => {
                setRequestFor(dayOpen);
                setDayOpen(null);
              }}
            >
              Request time off for this day
            </Button>
          </div>
        </Modal>
      )}
      {cancelling && (
        <ConfirmDialog
          title={
            cancelling.status === 'pending' ? 'Withdraw this request?' : 'Cancel this time off?'
          }
          confirmLabel={cancelling.status === 'pending' ? 'Withdraw' : 'Cancel time off'}
          danger
          loading={cancel.isPending}
          onConfirm={() => cancel.mutate(cancelling.id)}
          onClose={() => setCancelling(null)}
        >
          {cancelling.type.name}, {formatTimeOffWhen(cancelling, tz, timeFormat)}.
          {cancelling.status === 'approved' &&
            ' Your admin will be notified that you are available again.'}
        </ConfirmDialog>
      )}
    </>
  );
}

function DateBadge({ date }: { date: ISODate }) {
  const dt = DateTime.fromISO(date);
  return (
    <span className="flex w-10 shrink-0 flex-col items-center rounded-lg bg-slate-100 py-1 leading-none">
      <span className="text-[10px] font-semibold uppercase text-slate-500">
        {dt.toFormat('ccc')}
      </span>
      <span className="text-base font-bold text-slate-800">{dt.day}</span>
    </span>
  );
}

function MonthGrid({
  days,
  month,
  today,
  tz,
  shiftsByDay,
  holidays,
  timeOffOn,
  compact,
  onDayClick,
  onShiftClick,
}: {
  days: ISODate[];
  month: ISODate;
  today: ISODate;
  tz: string;
  shiftsByDay: Map<ISODate, ShiftView[]>;
  holidays: ReturnType<typeof useHolidays>;
  timeOffOn: (day: ISODate) => TimeOffRequest[];
  compact: boolean;
  onDayClick: (day: ISODate) => void;
  onShiftClick: (shift: ShiftView) => void;
}) {
  const timeFormat = useTimeFormat();
  const monthKey = month.slice(0, 7);
  return (
    <div className="p-2 sm:p-3">
      <div className="grid grid-cols-7 pb-1 text-center text-xs font-semibold text-slate-500">
        {days.slice(0, 7).map((d) => (
          <div key={d}>{DateTime.fromISO(d).toFormat(compact ? 'ccccc' : 'ccc')}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {days.map((day) => {
          const shifts = shiftsByDay.get(day) ?? [];
          const off = timeOffOn(day);
          const inMonth = day.slice(0, 7) === monthKey;
          const isToday = day === today;
          const weekend = dayOfWeek(day) === 0 || dayOfWeek(day) === 6;
          const holiday = holidays.get(day);
          return (
            <div
              key={day}
              role="button"
              tabIndex={0}
              aria-label={`${formatDay(day, 'long')}${holiday ? ` (${holiday.map((h) => h.name).join(', ')})` : ''}: ${shifts.length} shift${shifts.length === 1 ? '' : 's'}${off.length ? ', time off' : ''}`}
              onClick={() => onDayClick(day)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onDayClick(day);
                }
              }}
              className={cx(
                'group relative flex cursor-pointer flex-col gap-1 rounded-lg border p-1 text-left transition hover:border-brand-300 hover:bg-brand-50/40',
                compact ? 'min-h-14' : 'min-h-28 p-1.5',
                inMonth ? 'border-slate-200 bg-surface/70' : 'border-transparent bg-slate-50/60',
                weekend && inMonth && 'bg-slate-50/60',
                holiday && inMonth && 'bg-rose-50/50',
              )}
            >
              <span className="flex min-w-0 items-center gap-1">
                <span
                  className={cx(
                    'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                    isToday
                      ? 'neon bg-neon text-white'
                      : inMonth
                        ? 'text-slate-700'
                        : 'text-slate-400',
                  )}
                >
                  {DateTime.fromISO(day).day}
                </span>
              </span>
              {holiday &&
                (compact ? (
                  <Leaf className="absolute top-1 right-1 size-3 text-rose-600" aria-hidden />
                ) : (
                  <span className="flex min-w-0">
                    <HolidayBadge holidays={holiday} wrap />
                  </span>
                ))}
              {!compact && (
                <span className="absolute top-1.5 right-1.5 hidden text-[10px] font-semibold text-brand-600 group-hover:block">
                  + Time off
                </span>
              )}
              {compact ? (
                <div className="flex flex-wrap gap-0.5 px-0.5">
                  {off.map((r) => (
                    <span
                      key={r.id}
                      className="h-1.5 w-full rounded-full"
                      style={{
                        backgroundColor: r.type.color,
                        opacity: r.status === 'pending' ? 0.5 : 1,
                      }}
                    />
                  ))}
                  {shifts.map((s) => (
                    <span
                      key={s.id}
                      className={cx(
                        'size-2 rounded-full',
                        s.status === 'pending' && 'ring-2 ring-amber-300',
                      )}
                      style={{ backgroundColor: shiftColor(s) }}
                    />
                  ))}
                </div>
              ) : (
                <>
                  {off.map((r) => (
                    <div
                      key={r.id}
                      className={cx(
                        'stripes truncate rounded px-1.5 py-0.5 text-[11px] font-medium text-slate-700',
                        r.status === 'pending' && 'border border-dashed',
                      )}
                      style={{ backgroundColor: `${r.type.color}1f`, borderColor: r.type.color }}
                    >
                      {r.startTime && r.endTime && (
                        <span className="font-semibold text-slate-800">
                          {formatTimeRangeCompact(r.startTime, r.endTime, tz, timeFormat)}{' '}
                        </span>
                      )}
                      {r.type.name}
                      {r.status === 'pending' && ' (requested)'}
                    </div>
                  ))}
                  {shifts.slice(0, 3).map((s) => (
                    <div key={s.id} onClick={(e) => e.stopPropagation()}>
                      <ShiftChip
                        shift={s}
                        tz={tz}
                        color={shiftColor(s)}
                        labelName={s.label?.name}
                        status={s.status}
                        compact
                        onClick={() => onShiftClick(s)}
                      />
                    </div>
                  ))}
                  {shifts.length > 3 && (
                    <span className="px-1 text-[11px] text-slate-500">
                      +{shifts.length - 3} more
                    </span>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ShiftDetailsDialog({
  shift,
  tz,
  swap,
  onOffer,
  confirming,
  onConfirm,
  onClose,
}: {
  shift: ShiftView;
  tz: string;
  /** An open swap this shift is part of. */
  swap: ShiftSwap | undefined;
  /** Offer it to a coworker (for people in a tier). */
  onOffer?: () => void;
  confirming: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const me = useCurrentUser();
  const timeFormat = useTimeFormat();
  const now = useNow();
  const ended = Date.parse(shift.endTime) < now;
  const canOffer = onOffer && !swap && Date.parse(shift.startTime) > now;
  const offer = canOffer && (
    <Button icon={<Repeat className="size-4" />} onClick={onOffer}>
      Offer to a coworker
    </Button>
  );
  return (
    <Modal
      title={formatDay(localDate(shift.startTime, tz), 'long')}
      description={formatTimeRange(shift.startTime, shift.endTime, tz, { format: timeFormat })}
      onClose={onClose}
      size="sm"
      footer={
        shift.status === 'pending' && !ended ? (
          <>
            <Button onClick={onClose}>Close</Button>
            {offer}
            <Button
              variant="success"
              icon={<CalendarCheck className="size-4" />}
              loading={confirming}
              onClick={onConfirm}
            >
              Confirm shift
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Close</Button>
            {offer}
          </>
        )
      }
    >
      <dl className="space-y-3 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500">Schedule</dt>
          <dd className="font-medium">{shift.scheduleName}</dd>
        </div>
        {shift.tier && (
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">Tier</dt>
            <dd className="flex items-center gap-1.5 font-medium">
              <ColorDot color={shift.tier.color} /> {shift.tier.name}
            </dd>
          </div>
        )}
        {shift.label && (
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">Label</dt>
            <dd className="flex items-center gap-1.5 font-medium">
              <ColorDot color={shift.label.color} /> {shift.label.name}
            </dd>
          </div>
        )}
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500">Status</dt>
          <dd>
            {shift.status === 'confirmed' ? (
              <Badge tone="green">Confirmed</Badge>
            ) : (
              <Badge tone="amber">Waiting for your confirmation</Badge>
            )}
          </dd>
        </div>
        {swap && (
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">Swap</dt>
            <dd>
              <Badge tone={swapStatus(swap, me.id).tone}>
                {swap.requester.id === me.id
                  ? `Offered to ${firstName(swap.recipient.name)}`
                  : `From ${firstName(swap.requester.name)}`}{' '}
                · {swapStatus(swap, me.id).label.toLowerCase()}
              </Badge>
            </dd>
          </div>
        )}
        {shift.notes && (
          <div>
            <dt className="text-slate-500">Note</dt>
            <dd className="mt-1 rounded-lg bg-slate-50 px-3 py-2 text-slate-700">{shift.notes}</dd>
          </div>
        )}
      </dl>
      {shift.status === 'pending' && (
        <p className="mt-4 text-xs text-slate-500">
          Can't make this shift?{' '}
          {onOffer
            ? 'Offer it to a coworker, or let your admin know.'
            : 'Let your admin know so they can adjust the schedule.'}
        </p>
      )}
    </Modal>
  );
}
