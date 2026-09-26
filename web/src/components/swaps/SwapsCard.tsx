import type { ShiftSwap } from '@shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { keys, useMySwaps } from '../../api/queries';
import { useCurrentUser } from '../../lib/session';
import { firstName, isOpenSwap } from '../../lib/swaps';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Misc';
import { SwapSummary } from './SwapSummary';

/** Your swaps: offers to answer, your offers in progress, and recent outcomes. */
export function SwapsCard({ tz }: { tz: string }) {
  const me = useCurrentUser();
  const swaps = useMySwaps();
  const queryClient = useQueryClient();
  const act = useMutation({
    mutationFn: ({ swap, action }: { swap: ShiftSwap; action: 'accept' | 'decline' | 'cancel' }) =>
      api.post<ShiftSwap>(`/my/swaps/${swap.id}/${action}`),
    onSuccess: (swap, { action }) => {
      void queryClient.invalidateQueries({ queryKey: keys.mySwaps });
      const who = firstName(swap.requester.name);
      toast.success(
        action === 'accept'
          ? `Accepted: an admin will approve it, then it's on your schedule`
          : action === 'decline'
            ? `Declined. We've let ${who} know.`
            : 'Request withdrawn',
      );
    },
    onError: (e) => toast.error(e.message),
  });

  const list = swaps.data ?? [];
  // Open ones, then the five latest outcomes.
  const open = list.filter(isOpenSwap);
  const shown = [...open, ...list.filter((w) => !isOpenSwap(w)).slice(0, 5)];
  if (shown.length === 0) return null;
  const busy = (swap: ShiftSwap, action: string) =>
    act.isPending && act.variables?.swap.id === swap.id && act.variables.action === action;
  return (
    <Card>
      <CardHeader
        title="Shift swaps"
        description={open.length ? undefined : 'Recent swaps. Offer a shift from its details.'}
      />
      <ul className="divide-y divide-slate-100">
        {shown.map((swap) => (
          <li key={swap.id} className="space-y-2 px-5 py-3">
            <SwapSummary swap={swap} tz={tz} viewerId={me.id} />
            {swap.status === 'pending' && swap.recipient.id === me.id && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  icon={<X className="size-4" />}
                  loading={busy(swap, 'decline')}
                  onClick={() => act.mutate({ swap, action: 'decline' })}
                >
                  Decline
                </Button>
                <Button
                  size="sm"
                  variant="success"
                  icon={<Check className="size-4" />}
                  loading={busy(swap, 'accept')}
                  onClick={() => act.mutate({ swap, action: 'accept' })}
                >
                  Accept
                </Button>
              </div>
            )}
            {isOpenSwap(swap) && swap.requester.id === me.id && (
              <Button
                size="sm"
                variant="ghost"
                loading={busy(swap, 'cancel')}
                onClick={() => act.mutate({ swap, action: 'cancel' })}
              >
                Withdraw request
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
