import type { SessionUser, TimeFormat } from '@shared/types';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { CalendarFeedPanel } from '../../components/CalendarFeed';
import { ThemeToggle } from '../../components/ThemeToggle';
import { TimezoneSelect } from '../../components/TimezoneSelect';
import { Button } from '../../components/ui/Button';
import { Field, FormError, Input, Select, Toggle } from '../../components/ui/Form';
import { Card, CardHeader, PageHeader } from '../../components/ui/Misc';
import { fieldErrors, formMessage } from '../../lib/forms';
import { useBootstrapData, useCurrentUser, useSetSessionUser } from '../../lib/session';
import { zoneLabel } from '../../lib/timezones';

export default function ProfilePage() {
  const user = useCurrentUser();
  const { org } = useBootstrapData();
  const setSessionUser = useSetSessionUser();
  const [name, setName] = useState(user.name);
  const [timezone, setTimezone] = useState(user.timezone ?? '');
  const [timeFormat, setTimeFormat] = useState<TimeFormat | ''>(user.timeFormat ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');

  const saveProfile = useMutation({
    mutationFn: () =>
      api.patch<{ user: SessionUser }>('/me', {
        name,
        timezone: timezone || null,
        timeFormat: timeFormat || null,
      }),
    onSuccess: ({ user }) => {
      setSessionUser(user);
      toast.success('Profile saved');
    },
  });
  const savePassword = useMutation({
    mutationFn: () =>
      api.post<{ user: SessionUser }>('/me/password', {
        currentPassword: current || undefined,
        newPassword: next,
      }),
    onSuccess: ({ user }) => {
      setSessionUser(user);
      setCurrent('');
      setNext('');
      toast.success('Password updated. Other devices were signed out.');
    },
  });
  const saveNotifications = useMutation({
    mutationFn: (patch: { notifyTimeOff?: boolean; notifyConfirmations?: boolean }) =>
      api.patch<{ user: SessionUser }>('/me', patch),
    onSuccess: ({ user }) => {
      setSessionUser(user);
      toast.success('Email preferences saved');
    },
    onError: (e) => toast.error(e.message),
  });
  const signOutOthers = useMutation({
    mutationFn: () => api.post('/me/sign-out-others'),
    onSuccess: () => toast.success('Signed out of all other devices'),
    onError: (e) => toast.error(e.message),
  });
  const pwErrors = fieldErrors(savePassword.error);

  return (
    <div className="max-w-2xl">
      <PageHeader title="Your profile" description={user.email} />
      <div className="space-y-6">
        <Card>
          <CardHeader title="Details" />
          <form
            className="space-y-4 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              saveProfile.mutate();
            }}
          >
            <FormError message={formMessage(saveProfile.error)} />
            <Field label="Name">
              <Input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
            </Field>
            <Field label="Email" hint="Ask an admin if your email address needs to change.">
              <Input value={user.email} disabled />
            </Field>
            <Field label="Time zone" hint="Your schedule and emails show times in this zone.">
              <TimezoneSelect
                value={timezone}
                onChange={setTimezone}
                defaultOption={`Same as the team — ${zoneLabel(org.timezone)}`}
              />
            </Field>
            <Field label="Time format" hint="For times in the app and in your emails.">
              <Select
                value={timeFormat}
                onChange={(e) => setTimeFormat(e.target.value as TimeFormat | '')}
              >
                <option value="">
                  Same as the team —{' '}
                  {org.timeFormat === '24h' ? '24-hour (15:00)' : '12-hour (3:00 PM)'}
                </option>
                <option value="12h">12-hour (3:00 PM)</option>
                <option value="24h">24-hour (15:00)</option>
              </Select>
            </Field>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" loading={saveProfile.isPending}>
                Save changes
              </Button>
            </div>
          </form>
        </Card>

        <Card>
          <CardHeader
            title="Calendar"
            description="See your shifts and time off in Google Calendar, or any calendar app."
          />
          <div className="p-5">
            <CalendarFeedPanel />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Appearance"
            description="Light, dark, or follow your device. Saved on this device."
            actions={<ThemeToggle withLabels />}
          />
        </Card>

        {user.role === 'admin' && (
          <Card>
            <CardHeader
              title="Admin emails"
              description={`Sent to ${user.email}. You're never emailed about your own actions.`}
            />
            <div className="space-y-4 p-5">
              <Toggle
                checked={user.notifyTimeOff}
                disabled={saveNotifications.isPending}
                onChange={(notifyTimeOff) => saveNotifications.mutate({ notifyTimeOff })}
                label="Time-off requests"
                description="When someone requests time off, or cancels a request."
              />
              <Toggle
                checked={user.notifyConfirmations}
                disabled={saveNotifications.isPending}
                onChange={(notifyConfirmations) =>
                  saveNotifications.mutate({ notifyConfirmations })
                }
                label="Shift confirmations"
                description="When someone confirms one or more of their shifts."
              />
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Password"
            description={
              user.hasPassword
                ? undefined
                : 'You sign in with emailed links. Add a password to sign in faster.'
            }
          />
          <form
            className="space-y-4 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              savePassword.mutate();
            }}
          >
            <FormError
              message={formMessage(savePassword.error, ['currentPassword', 'newPassword'])}
            />
            {user.hasPassword && (
              <Field label="Current password" error={pwErrors.currentPassword}>
                <Input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                />
              </Field>
            )}
            <Field label="New password" error={pwErrors.newPassword} hint="At least 8 characters.">
              <Input
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" loading={savePassword.isPending}>
                {user.hasPassword ? 'Change password' : 'Set password'}
              </Button>
            </div>
          </form>
        </Card>

        <Card>
          <CardHeader
            title="Devices"
            description="Signed in on a shared or lost device? Sign out everywhere except here."
            actions={
              <Button onClick={() => signOutOthers.mutate()} loading={signOutOthers.isPending}>
                Sign out other devices
              </Button>
            }
          />
        </Card>
      </div>
    </div>
  );
}
