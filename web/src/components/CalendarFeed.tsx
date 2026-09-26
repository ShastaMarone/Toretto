import type { CalendarFeed } from '@shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api/client';
import { keys, useCalendarFeed } from '../api/queries';
import { Button, ButtonLink } from './ui/Button';
import { Field, Input } from './ui/Form';
import { ErrorBlock, Spinner } from './ui/Misc';
import { ConfirmDialog } from './ui/Modal';

/**
 * Google Calendar's "Add calendar?" page for a feed. It takes the link as
 * webcal:// (it turns down https://) and then fetches it over https.
 */
function googleCalendarLink(url: string): string {
  const webcal = url.replace(/^https?:\/\//, 'webcal://');
  return `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`;
}

/** Your secret calendar link: create it, add it to Google Calendar, copy, replace or turn it off. */
export function CalendarFeedPanel() {
  const feed = useCalendarFeed();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<'replace' | 'off' | null>(null);
  const saved = (next: CalendarFeed) => {
    queryClient.setQueryData(keys.calendarFeed, next);
    setConfirming(null);
  };
  const create = useMutation({
    mutationFn: () => api.post<CalendarFeed>('/me/calendar'),
    onSuccess: (next) => {
      if (feed.data?.url) toast.success('New link ready. Add it to your calendar again.');
      saved(next);
    },
    onError: (e) => toast.error(e.message),
  });
  const turnOff = useMutation({
    mutationFn: () => api.delete('/me/calendar'),
    onSuccess: () => {
      saved({ url: null });
      toast.success('Calendar link turned off');
    },
    onError: (e) => toast.error(e.message),
  });

  if (feed.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }
  if (feed.isError) return <ErrorBlock error={feed.error} onRetry={() => void feed.refetch()} />;

  const url = feed.data.url;
  if (!url) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          Get a private link to your published shifts and approved time off, then add it to Google
          Calendar. Changes show up there on their own.
        </p>
        <Button
          variant="primary"
          icon={<CalendarPlus className="size-4" />}
          loading={create.isPending}
          onClick={() => create.mutate()}
        >
          Create calendar link
        </Button>
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      toast.error("Couldn't copy. Select the link and copy it instead.");
    }
  };

  return (
    <div className="space-y-4">
      <ButtonLink
        to={googleCalendarLink(url)}
        target="_blank"
        rel="noreferrer"
        variant="primary"
        icon={<CalendarPlus className="size-4" />}
      >
        Add to Google Calendar
      </ButtonLink>
      <Field
        label="Your calendar link"
        hint="For Outlook, Apple Calendar or another app: subscribe to this link."
      >
        <div className="flex gap-2">
          <Input
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 font-mono text-xs"
          />
          <Button icon={<Copy className="size-4" />} onClick={() => void copy()}>
            Copy
          </Button>
        </div>
      </Field>
      <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
        <li>
          Google Calendar checks for changes every few hours, so an update can take up to a day to
          show there. Toretto and your emails always have the latest.
        </li>
        <li>Keep the link to yourself: anyone who has it can see your shifts.</li>
      </ul>
      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
        <Button size="sm" onClick={() => setConfirming('replace')}>
          Get a new link
        </Button>
        <Button size="sm" variant="danger-ghost" onClick={() => setConfirming('off')}>
          Turn off
        </Button>
      </div>

      {confirming === 'replace' && (
        <ConfirmDialog
          title="Get a new calendar link?"
          confirmLabel="Get new link"
          loading={create.isPending}
          onConfirm={() => create.mutate()}
          onClose={() => setConfirming(null)}
        >
          Your current link stops working, so calendars using it stop updating. Add the new link to
          Google Calendar, and remove the old calendar there.
        </ConfirmDialog>
      )}
      {confirming === 'off' && (
        <ConfirmDialog
          title="Turn off your calendar link?"
          confirmLabel="Turn off"
          danger
          loading={turnOff.isPending}
          onConfirm={() => turnOff.mutate()}
          onClose={() => setConfirming(null)}
        >
          The link stops working, so calendars using it stop updating. Remove the calendar from
          Google Calendar too, so old shifts don't stay there.
        </ConfirmDialog>
      )}
    </div>
  );
}
