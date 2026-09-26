import type { ShiftSwap, SwapStatus } from '@shared/types';
import type { Tone } from '../components/ui/Misc';

export const firstName = (name: string) => name.split(' ')[0] ?? name;

/** How a swap stands, from the reader's side ('admin' for admins looking at anyone's). */
export function swapStatus(
  swap: ShiftSwap,
  viewerId: string | 'admin',
): { label: string; tone: Tone } {
  const asked = swap.recipient.id === viewerId;
  const labels: Record<SwapStatus, { label: string; tone: Tone }> = {
    pending: asked
      ? { label: 'Waiting for you', tone: 'brand' }
      : { label: `Waiting for ${firstName(swap.recipient.name)}`, tone: 'amber' },
    accepted: { label: 'Waiting for an admin', tone: 'amber' },
    approved: { label: 'Approved', tone: 'green' },
    declined: { label: `${asked ? 'You' : firstName(swap.recipient.name)} declined`, tone: 'gray' },
    denied: { label: 'Declined by an admin', tone: 'red' },
    cancelled: { label: 'Withdrawn', tone: 'gray' },
    expired: { label: 'Expired', tone: 'gray' },
  };
  return labels[swap.status];
}

export const isOpenSwap = (swap: ShiftSwap) =>
  swap.status === 'pending' || swap.status === 'accepted';
