import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../api/client';
import { AuthLayout, TextLink } from '../../components/layout/AuthLayout';
import { Button } from '../../components/ui/Button';
import { Field, FormError, Input } from '../../components/ui/Form';
import { fieldErrors, formMessage } from '../../lib/forms';
import { useBootstrapData } from '../../lib/session';

export default function SignupPage() {
  const { selfSignup, allowedDomains } = useBootstrapData();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '' });
  const signup = useMutation({
    mutationFn: () => api.post('/auth/signup', form),
    onSuccess: () => navigate(`/check-email?reason=signup&email=${encodeURIComponent(form.email)}`),
  });
  const errors = fieldErrors(signup.error);
  const domainHint = allowedDomains.length
    ? `Use your ${allowedDomains.map((d) => `@${d}`).join(' or ')} email address.`
    : undefined;

  if (!selfSignup) {
    return (
      <AuthLayout
        title="Accounts are invite-only"
        footer={<TextLink to="/login">Back to sign in</TextLink>}
      >
        <p className="text-sm text-slate-600">
          Ask your scheduling admin to invite you. You'll get an email with a link to set up your
          account.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="We'll email you a link to confirm your address and choose a password."
      footer={
        <>
          Already have an account? <TextLink to="/login">Sign in</TextLink>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          signup.mutate();
        }}
      >
        <FormError message={formMessage(signup.error, ['name', 'email'])} />
        <Field label="Full name" error={errors.name}>
          <Input
            autoComplete="name"
            required
            autoFocus
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="Work email" error={errors.email} hint={domainHint}>
          <Input
            type="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={signup.isPending}>
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
