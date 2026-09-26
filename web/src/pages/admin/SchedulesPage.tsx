import {
  addDays,
  diffDays,
  formatDateRange,
  formatRelative,
  startOfWeek,
  todayIn,
} from '@shared/time';
import type { CreateScheduleResult, ScheduleSummary, Tier } from '@shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, CalendarRange, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { keys, useSchedules, useTiers } from '../../api/queries';
import { ConfirmationBar } from '../../components/schedule/ConfirmationBar';
import { StatusBadge } from '../../components/schedule/StatusBadge';
import { Button } from '../../components/ui/Button';
import { Field, FormError, Input, Select } from '../../components/ui/Form';
import { Modal } from '../../components/ui/Modal';
import {
  Card,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  Tabs,
} from '../../components/ui/Misc';
import { fieldErrors, formMessage } from '../../lib/forms';
import { scheduleTitle } from '../../lib/schedule';
import { useBootstrapData } from '../../lib/session';

function ScheduleRow({ schedule }: { schedule: ScheduleSummary }) {
  const published = schedule.status === 'published';
  const total = schedule.confirmedCount + schedule.pendingCount;
  return (
    <li>
      <Link
        to={`/admin/schedules/${schedule.id}`}
        className="flex items-center gap-4 px-4 py-3.5 hover:bg-slate-50 sm:px-5"
      >
        <span
          className="h-10 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: schedule.tierColor }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-slate-900">
              {scheduleTitle(schedule)}
            </p>
            <StatusBadge schedule={schedule} />
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            {schedule.tierName}
            {schedule.name && ` · ${formatDateRange(schedule.startDate, schedule.endDate)}`} ·{' '}
            {schedule.shiftCount} shift
            {schedule.shiftCount === 1 ? '' : 's'} · updated {formatRelative(schedule.updatedAt)}
          </p>
        </div>
        {published && total > 0 && (
          <div className="hidden sm:block">
            <ConfirmationBar confirmed={schedule.confirmedCount} total={total} />
          </div>
        )}
        <ChevronRight className="size-4 shrink-0 text-slate-400" />
      </Link>
    </li>
  );
}

export default function SchedulesPage() {
  const { org } = useBootstrapData();
  const today = todayIn(org.timezone);
  const schedules = useSchedules();
  const tiers = useTiers();
  const [params, setParams] = useSearchParams();
  const [tierFilter, setTierFilter] = useState('all');
  const creating = params.get('new') === '1';
  const setCreating = (open: boolean) => setParams(open ? { new: '1' } : {}, { replace: true });

  const list = (schedules.data ?? []).filter(
    (s) => tierFilter === 'all' || s.tierId === tierFilter,
  );
  const current = list
    .filter((s) => s.endDate >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const past = list.filter((s) => s.endDate < today);

  return (
    <>
      <PageHeader
        title="Schedules"
        description="Each tier has its own schedules. Build a draft, then publish it to the team."
        actions={
          <Button
            variant="primary"
            icon={<CalendarPlus className="size-4" />}
            onClick={() => setCreating(true)}
            disabled={!tiers.data?.length}
          >
            New schedule
          </Button>
        }
      />
      {tiers.data && tiers.data.length > 1 && (
        <Tabs
          className="mb-4 w-fit"
          value={tierFilter}
          onChange={setTierFilter}
          options={[
            { value: 'all', label: 'All tiers' },
            ...tiers.data.map((t) => ({ value: t.id, label: t.name })),
          ]}
        />
      )}
      {schedules.isLoading ? (
        <LoadingBlock />
      ) : schedules.isError ? (
        <ErrorBlock error={schedules.error} onRetry={() => void schedules.refetch()} />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CalendarRange />}
            title="No schedules yet"
            description="Create a schedule for a tier and a date range, add shifts, then publish."
            action={
              <Button
                variant="primary"
                onClick={() => setCreating(true)}
                disabled={!tiers.data?.length}
              >
                Create your first schedule
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-6">
          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-700">Current & upcoming</h2>
            <Card>
              {current.length ? (
                <ul className="divide-y divide-slate-100">
                  {current.map((s) => (
                    <ScheduleRow key={s.id} schedule={s} />
                  ))}
                </ul>
              ) : (
                <p className="px-5 py-6 text-sm text-slate-500">
                  Nothing upcoming — create next week's schedule.
                </p>
              )}
            </Card>
          </section>
          {past.length > 0 && (
            <details className="group">
              <summary className="mb-2 cursor-pointer text-sm font-semibold text-slate-700">
                Past schedules ({past.length})
              </summary>
              <Card>
                <ul className="divide-y divide-slate-100">
                  {past.map((s) => (
                    <ScheduleRow key={s.id} schedule={s} />
                  ))}
                </ul>
              </Card>
            </details>
          )}
        </div>
      )}
      {creating && tiers.data && (
        <NewScheduleDialog
          tiers={tiers.data}
          schedules={schedules.data ?? []}
          defaultTierId={tierFilter !== 'all' ? tierFilter : tiers.data[0]?.id}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
}

function suggestStart(tierId: string, schedules: ScheduleSummary[], nextWeek: string): string {
  const latest = schedules
    .filter((s) => s.tierId === tierId)
    .sort((a, b) => b.endDate.localeCompare(a.endDate))[0];
  if (latest && latest.endDate >= nextWeek) return addDays(latest.endDate, 1);
  return nextWeek;
}

function NewScheduleDialog({
  tiers,
  schedules,
  defaultTierId,
  onClose,
}: {
  tiers: Tier[];
  schedules: ScheduleSummary[];
  defaultTierId?: string;
  onClose: () => void;
}) {
  const { org } = useBootstrapData();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const nextWeek = addDays(startOfWeek(todayIn(org.timezone), org.weekStartsOn), 7);
  const [tierId, setTierId] = useState(defaultTierId ?? tiers[0]!.id);
  const [startDate, setStartDate] = useState(() => suggestStart(tierId, schedules, nextWeek));
  const [length, setLength] = useState<'7' | '14' | 'custom'>('7');
  const [customEnd, setCustomEnd] = useState(addDays(startDate, 6));
  const [name, setName] = useState('');
  const tierSchedules = schedules
    .filter((s) => s.tierId === tierId)
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
  const [copyFrom, setCopyFrom] = useState<string>(tierSchedules[0]?.id ?? '');
  const endDate = length === 'custom' ? customEnd : addDays(startDate, Number(length) - 1);

  const create = useMutation({
    mutationFn: () =>
      api.post<CreateScheduleResult>('/schedules', {
        tierId,
        startDate,
        endDate,
        name: name || null,
        copyFromScheduleId: copyFrom || null,
      }),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: keys.schedules });
      if (copyFrom) {
        toast.success(`Copied ${r.copied} shift${r.copied === 1 ? '' : 's'}`, {
          description: r.skipped
            ? `${r.skipped} skipped (outside the dates, overlapping, or deactivated people).`
            : undefined,
        });
      }
      navigate(`/admin/schedules/${r.schedule.id}`);
    },
  });
  const errors = fieldErrors(create.error);
  const days = diffDays(startDate, endDate) + 1;

  return (
    <Modal
      title="New schedule"
      description="Pick a tier and the days it covers. It starts as a draft only admins can see."
      onClose={onClose}
      onSubmit={() => create.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create draft
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError
          message={formMessage(create.error, ['tierId', 'startDate', 'endDate', 'name'])}
        />
        <Field label="Tier" error={errors.tierId}>
          <Select
            value={tierId}
            onChange={(e) => {
              const next = e.target.value;
              setTierId(next);
              setStartDate(suggestStart(next, schedules, nextWeek));
              setCopyFrom(
                schedules
                  .filter((s) => s.tierId === next)
                  .sort((a, b) => b.startDate.localeCompare(a.startDate))[0]?.id ?? '',
              );
            }}
          >
            {tiers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First day" error={errors.startDate}>
            <Input
              type="date"
              required
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </Field>
          <Field label="Length">
            <Select value={length} onChange={(e) => setLength(e.target.value as typeof length)}>
              <option value="7">1 week</option>
              <option value="14">2 weeks</option>
              <option value="custom">Custom…</option>
            </Select>
          </Field>
        </div>
        {length === 'custom' && (
          <Field label="Last day" error={errors.endDate} hint="Up to 6 weeks.">
            <Input
              type="date"
              required
              min={startDate}
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
            />
          </Field>
        )}
        <p className="text-sm text-slate-600">
          Covers <strong>{formatDateRange(startDate, endDate)}</strong> ({days} day
          {days === 1 ? '' : 's'}).
        </p>
        <Field
          label="Start from"
          hint="Copying keeps each shift's weekday, time, person and label."
        >
          <Select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
            <option value="">An empty schedule</option>
            {tierSchedules.map((s) => (
              <option key={s.id} value={s.id}>
                Copy of {scheduleTitle(s)} ({s.shiftCount} shifts)
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Name"
          optional
          hint="e.g. “Holiday coverage”. Defaults to the dates."
          error={errors.name}
        >
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
