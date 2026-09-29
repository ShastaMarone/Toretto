import type { SessionUser } from '@shared/types';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../api/client';
import { useCurrentUser, useSetSessionUser } from '../lib/session';
import { Button } from './ui/Button';
import { Toggle } from './ui/Form';
import { Modal } from './ui/Modal';

// The Google Apps Script version puts confirmed shifts and approved time off
// straight into people's Google Calendars (apps-script/src/services/calendar.ts).
// The web server has calendar feed links instead (CalendarFeed.tsx).

const WHAT =
  "Once you confirm a shift, it's added to your Google Calendar and updated if it changes. Your approved time off is added too.";

function useCalendarSync() {
  const user = useCurrentUser();
  const setSessionUser = useSetSessionUser();
  const save = useMutation({
    mutationFn: (calendarSync: boolean) =>
      api.patch<{ user: SessionUser }>('/me', { calendarSync }),
    onSuccess: ({ user: next }) => {
      setSessionUser(next);
      toast.success(
        next.calendarSync
          ? 'Your confirmed shifts will show up in Google Calendar in a few minutes'
          : 'Your upcoming shifts will come off your Google Calendar',
      );
    },
    onError: (e) => toast.error(e.message),
  });
  return { on: user.calendarSync === true, save };
}

/** Profile: on or off. */
export function CalendarSyncToggle() {
  const { on, save } = useCalendarSync();
  return (
    <Toggle
      checked={on}
      disabled={save.isPending}
      onChange={(next) => save.mutate(next)}
      label="Add my shifts to Google Calendar"
      description={WHAT}
    />
  );
}

/** My Schedule: what it does, and turning it on or off. */
export function CalendarSyncDialog({ onClose }: { onClose: () => void }) {
  const { on, save } = useCalendarSync();
  const set = (next: boolean) => save.mutate(next, { onSuccess: onClose });
  return (
    <Modal
      title={on ? 'Your shifts go to Google Calendar' : 'Add your shifts to Google Calendar'}
      onClose={onClose}
      footer={
        on ? (
          <>
            <Button onClick={() => set(false)} loading={save.isPending}>
              Turn off
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Not now</Button>
            <Button variant="primary" onClick={() => set(true)} loading={save.isPending}>
              Turn on
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3 text-sm text-slate-600">
        <p>{WHAT}</p>
        <p>
          They arrive as calendar invitations, usually within a few minutes.
          {on && ' Turning this off takes your upcoming shifts off your calendar.'}
        </p>
      </div>
    </Modal>
  );
}
