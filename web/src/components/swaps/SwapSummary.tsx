import { formatShiftWhen } from '@shared/time';
import type { ShiftSwap, SwapShift } from '@shared/types';
import { ArrowRight, Repeat } from 'lucide-react';
import { useTimeFormat } from '../../lib/session';
import { firstName, swapStatus } from '../../lib/swaps';
import { Badge, ColorDot } from '../ui/Misc';

function ShiftLine({ shift, tz }: { shift: SwapShift; tz: string }) {
  const timeFormat = useTimeFormat();
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <ColorDot color={shift.color ?? 'var(--color-slate-400)'} />
      <span className="truncate">
        {formatShiftWhen(shift.startTime, shift.endTime, tz, timeFormat)}
        {shift.labelName && <span className="text-slate-500"> · {shift.labelName}</span>}
      </span>
    </span>
  );
}

/** Who gives whom which shift (and what comes back in a trade), with its status. */
export function SwapSummary({
  swap,
  tz,
  viewerId,
}: {
  swap: ShiftSwap;
  tz: string;
  viewerId: string | 'admin';
}) {
  const status = swapStatus(swap, viewerId);
  const mine = swap.requester.id === viewerId;
  const asked = swap.recipient.id === viewerId;
  const headline = mine
    ? `You offered ${swap.recipient.name} your shift`
    : asked
      ? `${swap.requester.name} asked you to take their shift`
      : null;
  return (
    <div className="min-w-0 space-y-1 text-sm">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-slate-900">
        {headline ?? (
          <span className="flex items-center gap-1.5">
            {swap.requester.name}
            <ArrowRight className="size-3.5 text-slate-400" aria-label="to" />
            {swap.recipient.name}
          </span>
        )}
        <Badge tone={status.tone}>{status.label}</Badge>
      </p>
      <ShiftLine shift={swap.shift} tz={tz} />
      {swap.returnShift && (
        <p className="flex min-w-0 items-center gap-1.5 text-slate-600">
          <Repeat className="size-3.5 shrink-0 text-slate-400" aria-hidden />
          <span className="shrink-0">
            {mine ? 'For their' : asked ? 'For your' : `For ${firstName(swap.recipient.name)}'s`}
          </span>
          <ShiftLine shift={swap.returnShift} tz={tz} />
        </p>
      )}
      {swap.note && <p className="text-slate-500 italic">“{swap.note}”</p>}
      {swap.reviewNote && (
        <p className="text-slate-500">
          {swap.reviewedByName ?? 'Admin'}: “{swap.reviewNote}”
        </p>
      )}
    </div>
  );
}
