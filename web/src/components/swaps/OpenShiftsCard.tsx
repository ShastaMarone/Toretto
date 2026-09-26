import { formatShiftWhen } from '@shared/time';
import type { OpenShift } from '@shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Hand } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { keys, useMyOpenShifts } from '../../api/queries';
import { useTimeFormat } from '../../lib/session';
import { Button } from '../ui/Button';
import { Badge, Card, CardHeader, ColorDot } from '../ui/Misc';

/** Open shifts in your tier you can pick up, and the one(s) you're waiting on. */
export function OpenShiftsCard({ tz }: { tz: string }) {
  const timeFormat = useTimeFormat();
  const openShifts = useMyOpenShifts();
  const queryClient = useQueryClient();
  const act = useMutation({
    mutationFn: ({ openShift, action }: { openShift: OpenShift; action: 'claim' | 'release' }) =>
      api.post<OpenShift>(`/my/open-shifts/${openShift.id}/${action}`),
    onSuccess: (_openShift, { action }) => {
      void queryClient.invalidateQueries({ queryKey: keys.myOpenShifts });
      toast.success(
        action === 'claim'
          ? "Picked up: it's yours once an admin approves"
          : 'Let go: it’s open for others again',
      );
    },
    onError: (e) => {
      toast.error(e.message);
      void queryClient.invalidateQueries({ queryKey: keys.myOpenShifts });
    },
  });
  const list = openShifts.data ?? [];
  if (list.length === 0) return null;
  const busy = (o: OpenShift) => act.isPending && act.variables?.openShift.id === o.id;
  return (
    <Card>
      <CardHeader
        title="Open shifts"
        description="Anyone in your tier can pick these up. The first to do so gets it once an admin approves."
      />
      <ul className="divide-y divide-slate-100">
        {list.map((o) => (
          <li key={o.id} className="flex items-center gap-3 px-5 py-3">
            <div className="min-w-0 flex-1 text-sm">
              <p className="flex min-w-0 items-start gap-1.5 font-medium text-slate-900">
                <ColorDot color={o.label?.color ?? o.tier.color} className="mt-1.5" />
                <span>{formatShiftWhen(o.startTime, o.endTime, tz, timeFormat)}</span>
              </p>
              <p className="truncate text-xs text-slate-500">
                {[o.label?.name, o.notes].filter(Boolean).join(' · ') || o.scheduleName}
              </p>
            </div>
            {o.status === 'claimed' ? (
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Badge tone="amber">Waiting for an admin</Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy(o)}
                  onClick={() => act.mutate({ openShift: o, action: 'release' })}
                >
                  Let it go
                </Button>
              </div>
            ) : o.busy ? (
              <span className="shrink-0 text-xs text-slate-500">{o.busy}</span>
            ) : (
              <Button
                size="sm"
                variant="primary"
                icon={<Hand className="size-4" />}
                loading={busy(o)}
                onClick={() => act.mutate({ openShift: o, action: 'claim' })}
              >
                Pick up
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
