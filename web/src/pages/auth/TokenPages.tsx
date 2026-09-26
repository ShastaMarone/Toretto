import type { SessionUser } from '@shared/types';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { AuthLayout, TextLink } from '../../components/layout/AuthLayout';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Field, FormError, Input } from '../../components/ui/Form';
import { LoadingBlock } from '../../components/ui/Misc';
import { fieldErrors, formMessage } from '../../lib/forms';
import { homePath, safeNext, useBootstrapData, useSetSessionUser } from '../../lib/session';

function InvalidLink({ message, action }: { message: string; action?: 'reset' | 'magic' }) {
  return (
    <AuthLayout
      title="This link doesn't work anymore"
      footer={<TextLink to="/login">Go to sign in</TextLink>}
    >
      <div className="flex gap-3 text-sm text-slate-600">
        <CircleAlert className="size-5 shrink-0 text-amber-500" />
        <p>{message}</p>
      </div>
      {action && (
        <ButtonLink
          to={action === 'reset' ? '/forgot-password' : '/login'}
          variant="primary"
          className="mt-6 w-full"
        >
          {action === 'reset' ? 'Send me a new link' : 'Request a new sign-in link'}
        </ButtonLink>
      )}
    </AuthLayout>
  );
}

/** /magic-link?token=…&next=… — one-time sign-in link. */
export function MagicLinkPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const next = safeNext(params.get('next'));
  const { org } = useBootstrapData();
  const navigate = useNavigate();
  const setSessionUser = useSetSessionUser();
  const signIn = useMutation({
    mutationFn: () => api.post<{ user: SessionUser }>('/auth/magic-link/verify', { token }),
    onSuccess: ({ user }) => {
      setSessionUser(user);
      navigate(next ?? homePath(user), { replace: true });
    },
  });
  if (signIn.isError) return <InvalidLink message={signIn.error.message} action="magic" />;
  return (
    <AuthLayout title={`Sign in to ${org.name}`} subtitle="Your one-time sign-in link is ready.">
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        loading={signIn.isPending}
        onClick={() => signIn.mutate()}
      >
        Continue to my schedule
      </Button>
    </AuthLayout>
  );
}

/**
 * /set-password?token=… — accept an invite, confirm a new account, or finish a
 * password reset. Choosing the password here is what confirms the address.
 */
export function SetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const setSessionUser = useSetSessionUser();
  const { org } = useBootstrapData();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);

  const info = useQuery({
    queryKey: ['token-info', token],
    queryFn: () =>
      api.post<{
        purpose: 'invite' | 'verify_email' | 'reset_password';
        name: string;
        email: string;
      }>('/auth/token-info', { token }),
    retry: false,
    staleTime: Infinity,
  });
  const save = useMutation({
    mutationFn: () => api.post<{ user: SessionUser }>('/auth/set-password', { token, password }),
    onSuccess: ({ user }) => {
      setSessionUser(user);
      toast.success(
        info.data?.purpose === 'reset_password' ? 'Password updated' : `Welcome to ${org.name}!`,
      );
      navigate(homePath(user), { replace: true });
    },
  });

  if (info.isLoading) {
    return (
      <AuthLayout title="One moment…">
        <LoadingBlock />
      </AuthLayout>
    );
  }
  if (info.isError || !info.data) {
    return <InvalidLink message={info.error?.message ?? 'This link is invalid.'} action="reset" />;
  }
  // Invites and new-account confirmations both welcome the person in.
  const invite = info.data.purpose !== 'reset_password';
  const errors = fieldErrors(save.error);

  return (
    <AuthLayout
      title={invite ? `Welcome, ${info.data.name.split(' ')[0]}!` : 'Choose a new password'}
      subtitle={
        invite ? (
          <>
            Choose a password for <strong className="text-slate-700">{info.data.email}</strong> to{' '}
            {info.data.purpose === 'invite' ? `join ${org.name}` : 'finish creating your account'}.
          </>
        ) : (
          <>
            For <strong className="text-slate-700">{info.data.email}</strong>. This signs you out
            everywhere else.
          </>
        )
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (password !== confirm) return setMismatch(true);
          save.mutate();
        }}
      >
        <FormError message={formMessage(save.error, ['password'])} />
        <Field label="New password" error={errors.password} hint="At least 8 characters.">
          <Input
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Confirm password" error={mismatch ? "Passwords don't match" : null}>
          <Input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              setMismatch(false);
            }}
          />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={save.isPending}>
          {invite ? 'Set password & continue' : 'Save new password'}
        </Button>
      </form>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const send = useMutation({
    mutationFn: () => api.post('/auth/forgot-password', { email }),
    onSuccess: () => navigate(`/check-email?reason=reset&email=${encodeURIComponent(email)}`),
  });
  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter your email and we'll send you a link to choose a new password."
      footer={<TextLink to="/login">Back to sign in</TextLink>}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <FormError message={formMessage(send.error)} />
        <Field label="Email">
          <Input
            type="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={send.isPending}>
          Send reset link
        </Button>
      </form>
    </AuthLayout>
  );
}
