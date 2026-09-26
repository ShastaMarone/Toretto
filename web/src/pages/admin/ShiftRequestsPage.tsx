import {
  addDays,
  formatRelative,
  formatShiftWhen,
  shiftTimesFromLocal,
  todayIn,
} from '@shared/time';
import type { OpenShift, ShiftSwap } from '@shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, Hand, Plus, Repeat, X } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { api } from '../../api/client';
import {
  keys,
  useLabels,
  useOpenShifts,
  useSchedules,
  useSwaps,
  useTiers,
} from '../../api/queries';
import { SwapSummary } from '../../components/swaps/SwapSummary';
import { Button } from '../../components/ui/Button';
import { Field, FormError, Select, Textarea } from '../../components/ui/Form';
import { Modal } from '../../components/ui/Modal';
import {
  Badge,
  Card,
  ColorDot,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  Tabs,
  type Tone,
} from '../../components/ui/Misc';
import { DateInput, TimeInput } from '../../components/ui/Pickers';
import { fieldErrors, formMessage } from '../../lib/forms';
import { useBootstrapData, useTimeFormat, useViewerZone } from '../../lib/session';
import { firstName, isOpenSwap } from '../../lib/swaps';

type Tab = 'swaps' | 'open';

/** What people arrange between themselves, for an admin to approve: swaps and open shifts. */
export default function ShiftRequestsPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'open' ? 'open' : 'swaps';
  const [posting, setPosting] = useState(false);
  const swaps = useSwaps();
  const openShifts = useOpenShifts();
  return (
    <>
      <PageHeader
        title="Swaps & open shifts"
        description={
          tab === 'swaps'
            ? 'People swap shifts within their tier. Once the coworker agrees, you approve it and the schedule updates.'
            : 'Post a shift for everyone in a tier. The first to pick it up gets it once you approve.'
        }
        actions={
          tab === 'open' && (
            <Button
              variant="primary"
              icon={<Plus className="size-4" />}
              onClick={() => setPosting(true)}
            >
              Post open shift
            </Button>
          )
        }
      />
      <Tabs
        className="mb-4 w-fit"
        value={tab}
        onChange={(v) => setParams(v === 'open' ? { tab: v } : {}, { replace: true })}
        options={[
          {
            value: 'swaps',
            label: 'Swaps',
            count: swaps.data?.filter((w) => w.status === 'accepted').length,
          },
          {
            value: 'open',
            label: 'Open shifts',
            count: openShifts.data?.filter((o) => o.status === 'claimed').length,
          },
        ]}
      />
      {tab === 'swaps' ? <SwapsList /> : <OpenShiftsList onPost={() => setPosting(true)} />}
      {posting && <PostOpenShiftDialog onClose={() => setPosting(false)} />}
    </>
  );
}

const refreshSchedules = (queryClient: ReturnType<typeof useQueryClient>) => {
  void queryClient.invalidateQueries({ queryKey: ['schedule'] });
  void queryClient.invalidateQueries({ queryKey: ['team'] });
};

function SwapsList() {
  const tz = useViewerZone();
  const swaps = useSwaps();
  const queryClient = useQueryClient();
  const [declining, setDeclining] = useState<ShiftSwap | null>(null);
  const review = useMutation({
    mutationFn: ({
      swap,
      decision,
      note,
    }: {
      swap: ShiftSwap;
      decision: 'approve' | 'deny';
      note?: string;
    }) => api.post<ShiftSwap>(`/swaps/${swap.id}/${decision}`, { note: note || null }),
    onSuccess: (swap) => {
      toast.success(
        swap.status === 'approved'
          ? `Approved: ${firstName(swap.recipient.name)} has the shift now`
          : 'Swap declined',
        {
          description: `We've emailed ${firstName(swap.requester.name)} and ${firstName(swap.recipient.name)}.`,
        },
      );
      setDeclining(null);
      void queryClient.invalidateQueries({ queryKey: keys.swaps });
      refreshSchedules(queryClient);
    },
    onError: (e) => toast.error(e.message),
  });

  if (swaps.isPending) return <LoadingBlock />;
  if (swaps.isError) return <ErrorBlock error={swaps.error} onRetry={() => void swaps.refetch()} />;
  if (swaps.data.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Repeat />}
          title="No swaps yet"
          description="When someone offers a shift to a coworker in their tier, it shows up here. You'll get an email when one needs your approval."
        />
      </Card>
    );
  }
  return (
    <>
      <Card>
        <ul className="divide-y divide-slate-100">
          {swaps.data.map((swap) => (
            <li key={swap.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <SwapSummary swap={swap} tz={tz} viewerId="admin" />
                <p className="mt-1 text-xs text-slate-400">
                  Asked {formatRelative(swap.createdAt)}
                  {swap.reviewedByName &&
                    swap.reviewedAt &&
                    ` · ${swap.status === 'approved' ? 'approved' : 'declined'} by ${swap.reviewedByName} ${formatRelative(swap.reviewedAt)}`}
                </p>
              </div>
              {isOpenSwap(swap) && (
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    icon={<X className="size-4" />}
                    onClick={() => setDeclining(swap)}
                  >
                    Decline
                  </Button>
                  {swap.status === 'accepted' && (
                    <Button
                      size="sm"
                      variant="success"
                      icon={<Check className="size-4" />}
                      loading={
                        review.isPending &&
                        review.variables?.swap.id === swap.id &&
                        review.variables.decision === 'approve'
                      }
                      onClick={() => review.mutate({ swap, decision: 'approve' })}
                    >
                      Approve
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {declining && (
        <DeclineDialog
          title={`Decline ${firstName(declining.requester.name)} and ${firstName(declining.recipient.name)}'s swap?`}
          description="Nothing changes on the schedule. We'll email them both."
          confirmLabel="Decline swap"
          placeholder="e.g. We need Bo on the phones that day"
          loading={review.isPending}
          onConfirm={(note) => review.mutate({ swap: declining, decision: 'deny', note })}
          onClose={() => setDeclining(null)}
        />
      )}
    </>
  );
}

const OPEN_STATUS: Record<OpenShift['status'], { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'brand' },
  claimed: { label: 'Picked up, waiting for you', tone: 'amber' },
  filled: { label: 'Filled', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
  expired: { label: 'Expired', tone: 'gray' },
};

function OpenShiftsList({ onPost }: { onPost: () => void }) {
  const tz = useViewerZone();
  const timeFormat = useTimeFormat();
  const openShifts = useOpenShifts();
  const queryClient = useQueryClient();
  const [declining, setDeclining] = useState<OpenShift | null>(null);
  const act = useMutation({
    mutationFn: ({
      openShift,
      action,
      note,
    }: {
      openShift: OpenShift;
      action: 'approve' | 'deny' | 'cancel';
      note?: string;
    }) => api.post<OpenShift>(`/open-shifts/${openShift.id}/${action}`, { note: note || null }),
    onSuccess: (openShift, { action }) => {
      const who = openShift.claimedBy ? firstName(openShift.claimedBy.name) : null;
      toast.success(
        action === 'approve'
          ? `Approved: it's ${who}'s shift now`
          : action === 'deny'
            ? "Declined: it's open for the rest of the tier again"
            : 'Open shift cancelled',
      );
      setDeclining(null);
      void queryClient.invalidateQueries({ queryKey: keys.openShifts });
      refreshSchedules(queryClient);
    },
    onError: (e) => toast.error(e.message),
  });

  if (openShifts.isPending) return <LoadingBlock />;
  if (openShifts.isError)
    return <ErrorBlock error={openShifts.error} onRetry={() => void openShifts.refetch()} />;
  if (openShifts.data.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Hand />}
          title="No open shifts"
          description="Need someone to cover? Post an open shift and everyone in that tier is emailed."
          action={
            <Button icon={<Plus className="size-4" />} onClick={onPost}>
              Post open shift
            </Button>
          }
        />
      </Card>
    );
  }
  const loading = (o: OpenShift, action: string) =>
    act.isPending && act.variables?.openShift.id === o.id && act.variables.action === action;
  return (
    <>
      <Card>
        <ul className="divide-y divide-slate-100">
          {openShifts.data.map((o) => {
            const status = OPEN_STATUS[o.status];
            return (
              <li key={o.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1 space-y-1 text-sm">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-slate-900">
                    {formatShiftWhen(o.startTime, o.endTime, tz, timeFormat)}
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </p>
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-600">
                    <span className="flex items-center gap-1.5">
                      <ColorDot color={o.tier.color} /> {o.tier.name}
                    </span>
                    {o.label && (
                      <span className="flex items-center gap-1.5">
                        <ColorDot color={o.label.color} /> {o.label.name}
                      </span>
                    )}
                    {o.claimedBy && (
                      <span>
                        {o.status === 'filled' ? 'Given to' : 'Picked up by'}{' '}
                        <strong className="font-semibold">{o.claimedBy.name}</strong>
                      </span>
                    )}
                  </p>
                  {o.notes && <p className="text-slate-500 italic">“{o.notes}”</p>}
                  <p className="text-xs text-slate-400">Posted {formatRelative(o.createdAt)}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {(o.status === 'open' || o.status === 'claimed') && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Ban className="size-4" />}
                      loading={loading(o, 'cancel')}
                      onClick={() => act.mutate({ openShift: o, action: 'cancel' })}
                    >
                      Cancel
                    </Button>
                  )}
                  {o.status === 'claimed' && (
                    <>
                      <Button
                        size="sm"
                        icon={<X className="size-4" />}
                        onClick={() => setDeclining(o)}
                      >
                        Decline
                      </Button>
                      <Button
                        size="sm"
                        variant="success"
                        icon={<Check className="size-4" />}
                        loading={loading(o, 'approve')}
                        onClick={() => act.mutate({ openShift: o, action: 'approve' })}
                      >
                        Approve
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
      {declining && (
        <DeclineDialog
          title={`Decline ${firstName(declining.claimedBy?.name ?? 'their')}'s pickup?`}
          description={`It goes back to being open for the rest of ${declining.tier.name}. We'll email ${firstName(declining.claimedBy?.name ?? 'them')}.`}
          confirmLabel="Decline pickup"
          placeholder="e.g. You're already close to overtime that week"
          loading={act.isPending}
          onConfirm={(note) => act.mutate({ openShift: declining, action: 'deny', note })}
          onClose={() => setDeclining(null)}
        />
      )}
    </>
  );
}

function PostOpenShiftDialog({ onClose }: { onClose: () => void }) {
  const { org } = useBootstrapData();
  const timeFormat = useTimeFormat();
  const tiers = useTiers();
  const labels = useLabels();
  const schedules = useSchedules();
  const queryClient = useQueryClient();
  // Like the builder: times are in the organization's zone.
  const tz = org.timezone;
  const [form, setForm] = useState({
    tierId: '',
    labelId: '',
    scheduleId: '',
    date: addDays(todayIn(tz), 1),
    start: '09:00',
    end: '17:00',
    notes: '',
  });
  const tierId = form.tierId || tiers.data?.[0]?.id || '';
  const tierName = tiers.data?.find((t) => t.id === tierId)?.name ?? 'the tier';
  const usable = (labels.data ?? []).filter((l) => l.tierId === null || l.tierId === tierId);
  const save = useMutation({
    mutationFn: () =>
      api.post<OpenShift>('/open-shifts', {
        tierId,
        labelId: form.labelId || null,
        scheduleId: form.scheduleId || null,
        ...shiftTimesFromLocal(form.date, form.start, form.end, tz),
        notes: form.notes || null,
      }),
    onSuccess: (o) => {
      void queryClient.invalidateQueries({ queryKey: keys.openShifts });
      toast.success('Open shift posted', {
        description: `We've emailed everyone in ${o.tier.name}.`,
      });
      onClose();
    },
  });
  const errors = fieldErrors(save.error);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  return (
    <Modal
      title="Post an open shift"
      description="Everyone in the tier is emailed. The first to pick it up gets it once you approve."
      onClose={onClose}
      onSubmit={() => save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!tierId}>
            Post and email {tierName}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={formMessage(save.error, ['tierId', 'labelId', 'endTime'])} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="For" error={errors.tierId}>
            <Select value={tierId} onChange={(e) => set({ tierId: e.target.value, labelId: '' })}>
              {tiers.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  Everyone in {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Label" optional error={errors.labelId}>
            <Select value={form.labelId} onChange={(e) => set({ labelId: e.target.value })}>
              <option value="">No label</option>
              {usable.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Day">
            <DateInput value={form.date} onChange={(date) => set({ date })} />
          </Field>
          <Field label="Starts">
            <TimeInput
              value={form.start}
              format={timeFormat}
              onChange={(start) => set({ start })}
            />
          </Field>
          <Field label="Ends" error={errors.endTime}>
            <TimeInput
              value={form.end}
              format={timeFormat}
              after={form.start}
              onChange={(end) => set({ end })}
            />
          </Field>
        </div>
        {(schedules.data?.length ?? 0) > 1 && (
          <Field label="Schedule">
            <Select value={form.scheduleId} onChange={(e) => set({ scheduleId: e.target.value })}>
              {schedules.data?.map((s) => (
                <option key={s.id} value={s.isDefault ? '' : s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Note" optional hint="Shown to people deciding whether to pick it up.">
          <Textarea
            rows={2}
            maxLength={500}
            value={form.notes}
            onChange={(e) => set({ notes: e.target.value })}
            placeholder="e.g. Covering for Cy"
          />
        </Field>
      </div>
    </Modal>
  );
}

function DeclineDialog({
  title,
  description,
  confirmLabel,
  placeholder,
  loading,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  placeholder: string;
  loading: boolean;
  onConfirm: (note: string) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  return (
    <Modal
      title={title}
      description={description}
      onClose={onClose}
      onSubmit={() => onConfirm(note)}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Field label="Message" optional hint="Included in the email.">
        <Textarea
          autoFocus
          rows={3}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={placeholder}
        />
      </Field>
    </Modal>
  );
}
