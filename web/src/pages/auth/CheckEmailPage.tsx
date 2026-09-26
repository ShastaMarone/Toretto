import { useMutation } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { AuthLayout, TextLink } from '../../components/layout/AuthLayout';
import { Button, ButtonLink } from '../../components/ui/Button';
import { useBootstrapData } from '../../lib/session';

const MESSAGES: Record<string, (email: string) => string> = {
  setup: (email) =>
    `We sent a link to ${email}. Click it to confirm your address and choose your password.`,
  signup: (email) =>
    `We sent a link to ${email}. Click it to confirm your address and choose your password.`,
  magic: (email) =>
    `If ${email} has an account, a sign-in link is on its way. It works once and expires in 20 minutes.`,
  reset: (email) =>
    `If ${email} has an account, we sent a link to choose a new password. It expires in 1 hour.`,
};

export default function CheckEmailPage() {
  const [params] = useSearchParams();
  const reason = params.get('reason') ?? 'signup';
  const email = params.get('email') ?? 'your email';
  const { devMailbox } = useBootstrapData();
  const canResend = reason === 'setup' || reason === 'signup';
  const resend = useMutation({
    mutationFn: () => api.post('/auth/resend-verification', { email }),
    onSuccess: () => toast.success('Sent again — check your inbox (and spam folder).'),
    onError: (e) => toast.error(e.message),
  });

  return (
    <AuthLayout title="Check your email" footer={<TextLink to="/login">Back to sign in</TextLink>}>
      <div className="flex gap-4">
        <div className="shrink-0 rounded-full bg-indigo-50 p-3 text-indigo-600">
          <Inbox className="size-6" />
        </div>
        <p className="text-sm text-slate-600">{(MESSAGES[reason] ?? MESSAGES.signup!)(email)}</p>
      </div>
      <div className="mt-6 flex flex-col gap-2">
        {devMailbox && (
          <ButtonLink to="/dev/mailbox" variant="primary" className="w-full">
            Open the dev mailbox
          </ButtonLink>
        )}
        {canResend && (
          <Button onClick={() => resend.mutate()} loading={resend.isPending} className="w-full">
            Resend email
          </Button>
        )}
      </div>
      {devMailbox && (
        <p className="mt-3 text-center text-xs text-slate-500">
          Development mode: emails aren't really sent, they're shown in the dev mailbox.
        </p>
      )}
    </AuthLayout>
  );
}
