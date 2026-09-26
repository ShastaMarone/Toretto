import { formatRelative, todayIn } from '@shared/time';
import { formatTimeOffWhen, timeOffLength } from '@shared/timeOff';
import type { Person, TimeOffRequest } from '@shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Check, Plane, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { usePeople, useTimeOffRequests, useTimeOffTypes } from '../../api/queries';
import { TimeOffWhenFields } from '../../components/TimeOffWhenFields';
import { Button } from '../../components/ui/Button';
import { Field, FormError, Select, Textarea } from '../../components/ui/Form';
import { Modal } from '../../components/ui/Modal';
import {
  Avatar,
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
import { fieldErrors, formMessage } from '../../lib/forms';
import { useBootstrapData, useTimeFormat, useViewerZone } from '../../lib/session';
import { initialWhen, whenPayload } from '../../lib/timeOffWhen';

const STATUS: Record<TimeOffRequest['status'], { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'amber' },
  approved: { label: 'Approved', tone: 'green' },
  denied: { label: 'Declined', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
};

type TabKey = 'pending' | 'upcoming' | 'all';

export default function TimeOffAdminPage() {
  const { org } = useBootstrapData();
  const tz = useViewerZone();
  const timeFormat = useTimeFormat();
  const today = todayIn(org.timezone);
  const all = useTimeOffRequests('all');
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabKey>('pending');
  const [declining, setDeclining] = useState<TimeOffRequest | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['time-off'] });
    void queryClient.invalidateQueries({ queryKey: ['schedule'] });
    void queryClient.invalidateQueries({ queryKey: ['overview'] });
  };
  const review = useMutation({
    mutationFn: ({
      id,
      decision,
      note,
    }: {
      id: string;
      decision: 'approve' | 'deny';
      note?: string;
    }) => api.post<TimeOffRequest>(`/time-off/${id}/${decision}`, { note: note || null }),
    onSuccess: (r) => {
      toast.success(
        `${r.userName}'s ${r.type.name} ${r.status === 'approved' ? 'approved' : 'declined'}`,
        {
          description: `We've emailed ${r.userName.split(' ')[0]}.`,
        },
      );
      setDeclining(null);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const requests = all.data ?? [];
  const pending = requests
    .filter((r) => r.status === 'pending')
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const upcoming = requests
    .filter((r) => r.status === 'approved' && r.endDate >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const visible = tab === 'pending' ? pending : tab === 'upcoming' ? upcoming : requests;

  return (
    <>
      <PageHeader
        title="Time off"
        description="Review requests from your team. Approved time off shows on the schedule builder and team schedule."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            Add time off
          </Button>
        }
      />
      <Tabs
        className="mb-4 w-fit"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'pending', label: 'To review', count: pending.length },
          { value: 'upcoming', label: 'Upcoming' },
          { value: 'all', label: 'All requests' },
        ]}
      />
      {all.isLoading ? (
        <LoadingBlock />
      ) : all.isError ? (
        <ErrorBlock error={all.error} onRetry={() => void all.refetch()} />
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Plane />}
            title={tab === 'pending' ? 'No requests to review' : 'Nothing here yet'}
            description={
              tab === 'pending'
                ? 'New requests from your team will appear here, and you’ll get an email.'
                : undefined
            }
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {visible.map((r) => (
              <li key={r.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 gap-3">
                  <Avatar name={r.userName} />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
                      {r.userName}
                      <span className="flex items-center gap-1 text-xs font-medium text-slate-600">
                        <ColorDot color={r.type.color} /> {r.type.name}
                        {!r.type.paid && ' (unpaid)'}
                      </span>
                      {tab === 'all' && (
                        <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                      )}
                    </p>
                    <p className="text-sm text-slate-600">
                      {formatTimeOffWhen(r, tz, timeFormat)} · {timeOffLength(r)}
                    </p>
                    {r.note && <p className="mt-1 text-sm italic text-slate-500">“{r.note}”</p>}
                    {!!r.conflicts && r.status !== 'cancelled' && r.status !== 'denied' && (
                      <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-amber-700">
                        <CalendarClock className="size-3.5" />
                        Scheduled for {r.conflicts} shift{r.conflicts === 1 ? '' : 's'} during this
                        time — adjust the schedule after approving.
                      </p>
                    )}
                    <p className="mt-1 text-xs text-slate-400">
                      Requested {formatRelative(r.createdAt)}
                      {r.reviewedByName &&
                        r.reviewedAt &&
                        ` · ${STATUS[r.status].label.toLowerCase()} by ${r.reviewedByName} ${formatRelative(r.reviewedAt)}`}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2 sm:justify-end">
                  {(r.status === 'pending' || r.status === 'approved') && (
                    <Button
                      size="sm"
                      icon={<X className="size-4" />}
                      onClick={() => setDeclining(r)}
                    >
                      {r.status === 'approved' ? 'Revoke' : 'Decline'}
                    </Button>
                  )}
                  {(r.status === 'pending' || r.status === 'denied') && (
                    <Button
                      size="sm"
                      variant="success"
                      icon={<Check className="size-4" />}
                      loading={
                        review.isPending &&
                        review.variables?.id === r.id &&
                        review.variables.decision === 'approve'
                      }
                      onClick={() => review.mutate({ id: r.id, decision: 'approve' })}
                    >
                      Approve
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {declining && (
        <DeclineDialog
          request={declining}
          when={formatTimeOffWhen(declining, tz, timeFormat)}
          loading={review.isPending}
          onConfirm={(note) => review.mutate({ id: declining.id, decision: 'deny', note })}
          onClose={() => setDeclining(null)}
        />
      )}
      {adding && <AddTimeOffDialog onClose={() => setAdding(false)} onSaved={refresh} />}
    </>
  );
}

function DeclineDialog({
  request,
  when,
  loading,
  onConfirm,
  onClose,
}: {
  request: TimeOffRequest;
  when: string;
  loading: boolean;
  onConfirm: (note: string) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  return (
    <Modal
      title={`${request.status === 'approved' ? 'Revoke' : 'Decline'} ${request.userName}'s ${request.type.name}?`}
      description={when}
      onClose={onClose}
      onSubmit={() => onConfirm(note)}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={loading}>
            {request.status === 'approved' ? 'Revoke' : 'Decline'}
          </Button>
        </>
      }
    >
      <Field label="Message" optional hint="Included in the email to them.">
        <Textarea
          autoFocus
          rows={3}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. We're short-staffed that week — can we find another date?"
        />
      </Field>
    </Modal>
  );
}

function AddTimeOffDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { org } = useBootstrapData();
  const people = usePeople();
  const types = useTimeOffTypes();
  // Like the builder: hours are in the organization's zone.
  const tz = org.timezone;
  const [form, setForm] = useState({ userId: '', typeId: '', note: '' });
  const [when, setWhen] = useState(() => initialWhen(todayIn(tz)));
  const active = (people.data ?? []).filter((p: Person) => p.status !== 'deactivated');
  const userId = form.userId || active[0]?.id || '';
  const typeId = form.typeId || types.data?.[0]?.id || '';
  const save = useMutation({
    mutationFn: () =>
      api.post<TimeOffRequest>('/time-off', {
        userId,
        typeId,
        ...whenPayload(when, tz),
        note: form.note || null,
      }),
    onSuccess: (r) => {
      toast.success(`Added ${r.type.name} for ${r.userName}`);
      onSaved();
      onClose();
    },
  });
  const errors = fieldErrors(save.error);
  return (
    <Modal
      title="Add time off"
      description="Recorded as approved right away, and the person is emailed."
      onClose={onClose}
      onSubmit={() => save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            loading={save.isPending}
            disabled={!userId || !typeId}
          >
            Add time off
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError
          message={formMessage(save.error, [
            'userId',
            'typeId',
            'startDate',
            'endDate',
            'startTime',
            'endTime',
          ])}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Person" error={errors.userId}>
            <Select value={userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
              {active.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Type" error={errors.typeId}>
            <Select value={typeId} onChange={(e) => setForm({ ...form, typeId: e.target.value })}>
              {types.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <TimeOffWhenFields value={when} onChange={setWhen} errors={errors} />
        <Field label="Note" optional>
          <Textarea
            rows={2}
            maxLength={500}
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </Field>
      </div>
    </Modal>
  );
}
