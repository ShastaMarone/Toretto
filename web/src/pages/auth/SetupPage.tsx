import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { api } from '../../api/client';
import { TimezoneSelect } from '../../components/TimezoneSelect';
import { AuthLayout } from '../../components/layout/AuthLayout';
import { Button } from '../../components/ui/Button';
import { Field, FormError, Input } from '../../components/ui/Form';
import { fieldErrors, formMessage } from '../../lib/forms';
import { keys } from '../../api/queries';
import { useBootstrapData } from '../../lib/session';
import { browserZone } from '../../lib/timezones';

export default function SetupPage() {
  const { setupRequired } = useBootstrapData();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    orgName: '',
    name: '',
    email: '',
    timezone: browserZone(),
  });
  const setup = useMutation({
    mutationFn: () => api.post<{ email: string }>('/auth/setup', form),
    onSuccess: ({ email }) => {
      // Navigate before refreshing the session so this page never sees
      // "setup complete" while still mounted.
      navigate(`/check-email?reason=setup&email=${encodeURIComponent(email)}`, { replace: true });
      void queryClient.invalidateQueries({ queryKey: keys.bootstrap });
    },
  });
  const errors = fieldErrors(setup.error);
  if (!setupRequired && !setup.isSuccess) return <Navigate to="/login" replace />;

  return (
    <AuthLayout
      title="Set up your team's scheduling"
      subtitle="Create the first admin account. We'll email you a link to confirm your address and choose a password."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setup.mutate();
        }}
      >
        <FormError message={formMessage(setup.error, Object.keys(form))} />
        <Field label="Team or organization name" error={errors.orgName}>
          <Input
            required
            autoFocus
            placeholder="e.g. Customer Support"
            value={form.orgName}
            onChange={(e) => setForm({ ...form, orgName: e.target.value })}
          />
        </Field>
        <Field label="Your name" error={errors.name}>
          <Input
            autoComplete="name"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="Your email" error={errors.email}>
          <Input
            type="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </Field>
        <Field
          label="Time zone"
          error={errors.timezone}
          hint="Schedules are built in this time zone. People can pick their own later."
        >
          <TimezoneSelect
            value={form.timezone}
            onChange={(timezone) => setForm({ ...form, timezone })}
            required
          />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={setup.isPending}>
          Create admin account
        </Button>
        <p className="text-center text-xs text-slate-500">
          We'll create Tier 1, Tier 2 and Tier 3 plus a few example labels to get you started.
        </p>
      </form>
    </AuthLayout>
  );
}
