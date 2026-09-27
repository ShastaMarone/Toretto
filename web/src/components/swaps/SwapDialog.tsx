import { formatShiftWhen } from '@shared/time';
import type { ShiftSwap, ShiftView, SwapOption } from '@shared/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, qs } from '../../api/client';
import { keys } from '../../api/queries';
import { cx } from '../../lib/cx';
import { formMessage } from '../../lib/forms';
import { useTimeFormat } from '../../lib/session';
import { firstName } from '../../lib/swaps';
import { Button } from '../ui/Button';
import { Field, FormError, Textarea } from '../ui/Form';
import { ColorDot, ErrorBlock, Spinner } from '../ui/Misc';
import { Modal } from '../ui/Modal';

const choice =
  'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm transition has-[:checked]:border-transparent has-[:checked]:bg-brand-50 has-[:checked]:ring-2 has-[:checked]:ring-brand-500 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60';

/** Offer one of your shifts to a coworker in your tier, optionally taking one of theirs back. */
export function SwapDialog({
  shift,
  tz,
  onClose,
}: {
  shift: ShiftView;
  tz: string;
  onClose: () => void;
}) {
  const timeFormat = useTimeFormat();
  const queryClient = useQueryClient();
  const options = useQuery({
    queryKey: ['swap-options', shift.id],
    queryFn: () => api.get<SwapOption[]>(`/my/swaps/options${qs({ shiftId: shift.id })}`),
  });
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [returnShiftId, setReturnShiftId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const chosen = options.data?.find((o) => o.id === recipientId);
  // Busy then, but free if they trade away the shift they have at that time.
  const tradeOnly = chosen?.busy != null;

  const send = useMutation({
    mutationFn: () =>
      api.post<ShiftSwap>('/my/swaps', {
        shiftId: shift.id,
        recipientId,
        returnShiftId,
        note: note || null,
      }),
    onSuccess: (swap) => {
      void queryClient.invalidateQueries({ queryKey: keys.mySwaps });
      toast.success(`Asked ${firstName(swap.recipient.name)}`, {
        description: "You'll get an email when they answer. It's still your shift until approved.",
      });
      onClose();
    },
  });

  return (
    <Modal
      title="Offer this shift"
      description={formatShiftWhen(shift.startTime, shift.endTime, tz, timeFormat)}
      onClose={onClose}
      onSubmit={() => send.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            loading={send.isPending}
            disabled={!chosen || (tradeOnly && !returnShiftId)}
          >
            Send request
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <FormError message={formMessage(send.error)} />
        {options.isPending ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : options.isError ? (
          <ErrorBlock error={options.error} onRetry={() => void options.refetch()} />
        ) : options.data.length === 0 ? (
          <p className="text-sm text-slate-600">
            There's no one else in your tier to swap with. Ask your admin to change the schedule.
          </p>
        ) : (
          <>
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-slate-700">
                Who should take it? <span className="font-normal text-slate-500">(your tier)</span>
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {options.data.map((o) => {
                  const unavailable = o.busy !== null && o.shifts.length === 0;
                  return (
                    <label key={o.id} className={cx(choice, 'border-slate-200')}>
                      <input
                        type="radio"
                        name="recipient"
                        className="mt-1 accent-brand-600"
                        checked={o.id === recipientId}
                        disabled={unavailable}
                        onChange={() => {
                          setRecipientId(o.id);
                          setReturnShiftId(null);
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block font-medium text-slate-900">{o.name}</span>
                        <span className="block text-xs text-slate-500">
                          {o.busy === null
                            ? 'Free then'
                            : unavailable
                              ? o.busy
                              : `${o.busy}, so only as a trade`}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {chosen && (
              <fieldset>
                <legend className="mb-2 text-sm font-medium text-slate-700">In return</legend>
                <div className="space-y-2">
                  <label className={cx(choice, 'border-slate-200')}>
                    <input
                      type="radio"
                      name="return"
                      className="mt-1 accent-brand-600"
                      checked={returnShiftId === null}
                      disabled={tradeOnly}
                      onChange={() => setReturnShiftId(null)}
                    />
                    <span>Nothing: {firstName(chosen.name)} takes it as an extra shift</span>
                  </label>
                  {chosen.shifts.map((s) => (
                    <label key={s.id} className={cx(choice, 'border-slate-200')}>
                      <input
                        type="radio"
                        name="return"
                        className="mt-1 accent-brand-600"
                        checked={returnShiftId === s.id}
                        onChange={() => setReturnShiftId(s.id)}
                      />
                      <span className="flex min-w-0 items-center gap-1.5">
                        <ColorDot color={s.color ?? 'var(--color-slate-400)'} />
                        <span>
                          You take their {formatShiftWhen(s.startTime, s.endTime, tz, timeFormat)}
                          {s.labelName && <span className="text-slate-500"> · {s.labelName}</span>}
                        </span>
                      </span>
                    </label>
                  ))}
                  {chosen.shifts.length === 0 && (
                    <p className="text-xs text-slate-500">
                      {firstName(chosen.name)} has no shifts in the next 60 days that you could take
                      instead.
                    </p>
                  )}
                </div>
              </fieldset>
            )}

            <Field label="Note" optional>
              <Textarea
                rows={2}
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. I have an appointment that afternoon"
              />
            </Field>
            <p className="text-xs text-slate-500">
              They accept, then an admin approves. Until then it's still your shift.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
