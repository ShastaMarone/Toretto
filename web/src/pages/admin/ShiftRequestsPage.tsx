import { formatRelative } from '@shared/time';
import type { ShiftSwap } from '@shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Repeat, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { keys, useSwaps } from '../../api/queries';
import { SwapSummary } from '../../components/swaps/SwapSummary';
import { Button } from '../../components/ui/Button';
import { Field, Textarea } from '../../components/ui/Form';
import { Modal } from '../../components/ui/Modal';
import { Card, EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../../components/ui/Misc';
import { useViewerZone } from '../../lib/session';
import { firstName, isOpenSwap } from '../../lib/swaps';

/** Admins settle what people ask for between themselves: shift swaps. */
export default function ShiftRequestsPage() {
  return (
    <>
      <PageHeader
        title="Swaps"
        description="People swap shifts within their tier. Once the coworker agrees, you approve it and the schedule updates."
      />
      <SwapsList />
    </>
  );
}

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
      void queryClient.invalidateQueries({ queryKey: ['schedule'] });
      void queryClient.invalidateQueries({ queryKey: ['team'] });
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
        <DeclineSwapDialog
          swap={declining}
          loading={review.isPending}
          onConfirm={(note) => review.mutate({ swap: declining, decision: 'deny', note })}
          onClose={() => setDeclining(null)}
        />
      )}
    </>
  );
}

function DeclineSwapDialog({
  swap,
  loading,
  onConfirm,
  onClose,
}: {
  swap: ShiftSwap;
  loading: boolean;
  onConfirm: (note: string) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  return (
    <Modal
      title={`Decline ${firstName(swap.requester.name)} and ${firstName(swap.recipient.name)}'s swap?`}
      description="Nothing changes on the schedule. We'll email them both."
      onClose={onClose}
      onSubmit={() => onConfirm(note)}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={loading}>
            Decline swap
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
          placeholder="e.g. We need Bo on the phones that day"
        />
      </Field>
    </Modal>
  );
}
