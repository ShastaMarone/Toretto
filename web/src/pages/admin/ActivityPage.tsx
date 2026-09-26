import { formatRelative, formatTimestamp } from '@shared/time';
import type { NotificationEntry } from '@shared/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Mail, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { useActivity, useNotifications } from '../../api/queries';
import { ActivityLine } from '../../components/ActivityLine';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Form';
import { Modal } from '../../components/ui/Modal';
import {
  Badge,
  Card,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  Tabs,
  type Tone,
} from '../../components/ui/Misc';
import { useBootstrapData, useCurrentUser } from '../../lib/session';

const STATUS: Record<NotificationEntry['status'], Tone> = {
  queued: 'amber',
  sending: 'blue',
  sent: 'green',
  failed: 'red',
};

const KIND: Record<string, string> = {
  verify_email: 'Confirm email',
  invite: 'Invite',
  reset_password: 'Password reset',
  magic_link: 'Sign-in link',
  account_exists: 'Account exists',
  schedule_published: 'Schedule published',
  schedule_updated: 'Schedule updated',
  schedule_cancelled: 'Shifts cancelled',
  shift_reminder: 'Confirmation reminder',
  time_off_requested: 'Time-off request',
  time_off_reviewed: 'Time-off decision',
  time_off_cancelled: 'Time off cancelled',
};

export default function ActivityPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'emails' ? 'emails' : 'activity';
  return (
    <>
      <PageHeader
        title="Activity"
        description="Who did what and when — publishes, confirmations, approvals — plus every email sent."
      />
      <Tabs
        className="mb-4 w-fit"
        value={tab}
        onChange={(v) => setParams(v === 'emails' ? { tab: 'emails' } : {}, { replace: true })}
        options={[
          { value: 'activity', label: 'Audit trail' },
          { value: 'emails', label: 'Email log' },
        ]}
      />
      {tab === 'activity' ? <AuditTrail /> : <EmailLog />}
    </>
  );
}

function AuditTrail() {
  const user = useCurrentUser();
  const { org } = useBootstrapData();
  const activity = useActivity();
  if (activity.isLoading) return <LoadingBlock />;
  if (activity.isError)
    return <ErrorBlock error={activity.error} onRetry={() => void activity.refetch()} />;
  return (
    <Card>
      {activity.data?.length ? (
        <ul className="divide-y divide-slate-100">
          {activity.data.map((a) => (
            <ActivityLine key={a.id} entry={a} tz={user.timezone ?? org.timezone} />
          ))}
        </ul>
      ) : (
        <EmptyState icon={<Activity />} title="No activity yet" />
      )}
    </Card>
  );
}

function EmailLog() {
  const user = useCurrentUser();
  const { org } = useBootstrapData();
  const tz = user.timezone ?? org.timezone;
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const emails = useNotifications(status);
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/admin/notifications/${id}/retry`),
    onSuccess: () => {
      toast.success('Queued for another try');
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <div className="mb-3 flex items-center gap-3">
        <div className="w-44">
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All emails</option>
            <option value="sent">Sent</option>
            <option value="queued">Queued</option>
            <option value="failed">Failed</option>
          </Select>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw className="size-4" />}
          onClick={() => void emails.refetch()}
        >
          Refresh
        </Button>
      </div>
      {emails.isLoading ? (
        <LoadingBlock />
      ) : emails.isError ? (
        <ErrorBlock error={emails.error} onRetry={() => void emails.refetch()} />
      ) : !emails.data?.length ? (
        <Card>
          <EmptyState icon={<Mail />} title="No emails" />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {emails.data.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <button
                  type="button"
                  onClick={() => setOpenId(e.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-sm font-medium text-slate-900 hover:text-brand-600">
                    {e.subject}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    To {e.userName ? `${e.userName} <${e.toEmail}>` : e.toEmail} ·{' '}
                    {KIND[e.kind] ?? e.kind} ·{' '}
                    <span title={formatTimestamp(e.createdAt, tz)}>
                      {formatRelative(e.createdAt)}
                    </span>
                  </p>
                  {e.lastError && (
                    <p className="mt-0.5 truncate text-xs text-rose-600">{e.lastError}</p>
                  )}
                </button>
                <Badge tone={STATUS[e.status]}>
                  {e.status}
                  {e.attempts > 1 && ` · ${e.attempts} tries`}
                </Badge>
                {e.status === 'failed' && (
                  <Button
                    size="sm"
                    loading={retry.isPending && retry.variables === e.id}
                    onClick={() => retry.mutate(e.id)}
                  >
                    Retry
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {openId && <EmailPreview id={openId} tz={tz} onClose={() => setOpenId(null)} />}
    </>
  );
}

function EmailPreview({ id, tz, onClose }: { id: string; tz: string; onClose: () => void }) {
  const email = useQuery({
    queryKey: ['notification', id],
    queryFn: () =>
      api.get<NotificationEntry & { html: string | null }>(`/admin/notifications/${id}`),
  });
  return (
    <Modal
      title={email.data?.subject ?? 'Email'}
      description={
        email.data
          ? `To ${email.data.toEmail} · ${formatTimestamp(email.data.createdAt, tz)}`
          : undefined
      }
      onClose={onClose}
      size="xl"
    >
      {email.isLoading ? (
        <LoadingBlock />
      ) : email.data?.html ? (
        <iframe
          title="Email preview"
          sandbox=""
          srcDoc={email.data.html}
          className="h-[60dvh] w-full rounded-lg border border-slate-200"
        />
      ) : (
        <p className="text-sm text-slate-600">
          This email contains a private sign-in or confirmation link, so its content isn't shown to
          admins.
        </p>
      )}
    </Modal>
  );
}
