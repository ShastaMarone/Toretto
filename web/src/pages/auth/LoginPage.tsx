import type { SessionUser } from '@shared/types';
import { useMutation } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { AuthLayout, TextLink } from '../../components/layout/AuthLayout';
import { Button } from '../../components/ui/Button';
import { Field, FormError, Input } from '../../components/ui/Form';
import { fieldErrors, formMessage, isCode } from '../../lib/forms';
import { homePath, safeNext, useBootstrapData, useSetSessionUser } from '../../lib/session';

export default function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const { selfSignup } = useBootstrapData();
  const navigate = useNavigate();
  const setSessionUser = useSetSessionUser();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [magicError, setMagicError] = useState<string | null>(null);

  const login = useMutation({
    mutationFn: () => api.post<{ user: SessionUser }>('/auth/login', { email, password }),
    onSuccess: ({ user }) => {
      setSessionUser(user);
      navigate(next ?? homePath(user), { replace: true });
    },
  });
  const magic = useMutation({
    mutationFn: () => api.post('/auth/magic-link', { email, next: next ?? undefined }),
    onSuccess: () => navigate(`/check-email?reason=magic&email=${encodeURIComponent(email)}`),
  });
  const resend = useMutation({
    mutationFn: () => api.post('/auth/resend-verification', { email }),
    onSuccess: () => toast.success('Confirmation email sent — check your inbox.'),
  });

  const errors = fieldErrors(login.error);
  const notVerified = isCode(login.error, 'EMAIL_NOT_VERIFIED');

  return (
    <AuthLayout
      title="Sign in"
      subtitle="See your shifts, confirm them and request time off."
      footer={
        selfSignup ? (
          <>
            New here?{' '}
            <TextLink to={`/signup${next ? `?next=${encodeURIComponent(next)}` : ''}`}>
              Create an account
            </TextLink>
          </>
        ) : (
          'Need an account? Ask your admin to invite you.'
        )
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        {notVerified ? (
          <div
            role="alert"
            className="rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-800 ring-1 ring-inset ring-amber-200"
          >
            <p>{login.error?.message}</p>
            <button
              type="button"
              className="mt-1 font-semibold text-amber-900 underline underline-offset-2"
              onClick={() => resend.mutate()}
              disabled={resend.isPending}
            >
              Resend confirmation email
            </button>
          </div>
        ) : (
          <FormError
            message={
              formMessage(login.error, ['email', 'password']) ??
              formMessage(magic.error) ??
              magicError
            }
          />
        )}
        <Field label="Email" error={errors.email}>
          <Input
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            autoFocus
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setMagicError(null);
            }}
          />
        </Field>
        <div>
          <Field label="Password" error={errors.password}>
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <div className="mt-1.5 text-right">
            <Link
              to="/forgot-password"
              className="text-xs font-semibold text-indigo-600 hover:text-indigo-500"
            >
              Forgot password?
            </Link>
          </div>
        </div>
        <Button type="submit" variant="primary" className="w-full" loading={login.isPending}>
          Sign in
        </Button>
      </form>
      <div className="my-5 flex items-center gap-3 text-xs text-slate-400">
        <div className="h-px flex-1 bg-slate-200" />
        or
        <div className="h-px flex-1 bg-slate-200" />
      </div>
      <Button
        className="w-full"
        icon={<Mail className="size-4" />}
        loading={magic.isPending}
        onClick={() => {
          if (!email.includes('@'))
            setMagicError('Enter your email above first, then we’ll send you a link.');
          else magic.mutate();
        }}
      >
        Email me a sign-in link
      </Button>
    </AuthLayout>
  );
}
