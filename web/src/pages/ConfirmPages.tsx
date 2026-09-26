import type { ShiftView } from '@shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarX2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Navigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { api } from '../api/client';
import { ButtonLink } from '../components/ui/Button';
import { Card, EmptyState, LoadingBlock } from '../components/ui/Misc';
import { isCode } from '../lib/forms';

function useRunOnce(fn: () => void) {
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    fn();
  }, [fn]);
}

function Failed({ error }: { error: Error }) {
  return (
    <Card className="mx-auto max-w-lg">
      <EmptyState
        icon={<CalendarX2 />}
        title={
          isCode(error, 'NOT_FOUND')
            ? "This shift isn't assigned to you anymore"
            : "Couldn't confirm"
        }
        description={
          isCode(error, 'NOT_FOUND')
            ? 'The schedule may have changed since the email was sent. Check your schedule for the latest shifts.'
            : error.message
        }
        action={
          <ButtonLink to="/my-schedule" variant="primary">
            Open my schedule
          </ButtonLink>
        }
      />
    </Card>
  );
}

/** /confirm-shift/:id — the "Confirm this shift" link in schedule emails. */
export function ConfirmShiftPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const confirm = useMutation({
    mutationFn: () => api.post<ShiftView>(`/my/shifts/${id}/confirm`),
    onSuccess: () => {
      toast.success('Shift confirmed — thanks!');
      void queryClient.invalidateQueries({ queryKey: ['my-shifts'] });
    },
  });
  useRunOnce(confirm.mutate);
  if (confirm.isSuccess) return <Navigate to="/my-schedule" replace />;
  if (confirm.isError) return <Failed error={confirm.error} />;
  return <LoadingBlock label="Confirming your shift…" />;
}

/** /confirm-shifts/:scheduleId — the "Confirm all" button in schedule emails. */
export function ConfirmScheduleShiftsPage() {
  const { scheduleId = '' } = useParams();
  const queryClient = useQueryClient();
  const confirm = useMutation({
    mutationFn: () => api.post<{ confirmed: number }>('/my/shifts/confirm', { scheduleId }),
    onSuccess: ({ confirmed }) => {
      toast.success(
        confirmed
          ? `Confirmed ${confirmed} shift${confirmed === 1 ? '' : 's'} — thanks!`
          : 'All your shifts were already confirmed.',
      );
      void queryClient.invalidateQueries({ queryKey: ['my-shifts'] });
    },
  });
  useRunOnce(confirm.mutate);
  if (confirm.isSuccess) return <Navigate to="/my-schedule" replace />;
  if (confirm.isError) return <Failed error={confirm.error} />;
  return <LoadingBlock label="Confirming your shifts…" />;
}
