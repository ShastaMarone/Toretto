import type { MailboxMessage } from '@shared/types';
import { formatRelative } from '@shared/time';
import { useQuery } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { Badge, EmptyState, ErrorBlock, LoadingBlock } from '../components/ui/Misc';
import { cx } from '../lib/cx';

/** Development only: every email the app "sends", so you can click the links. */
export default function DevMailboxPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const mailbox = useQuery({
    queryKey: ['dev-mailbox'],
    queryFn: () => api.get<MailboxMessage[]>('/dev/mailbox'),
    refetchInterval: 3000,
    retry: false,
  });
  const messages = mailbox.data ?? [];
  const selected = messages.find((m) => m.id === selectedId) ?? messages[0];

  return (
    <div className="flex h-dvh flex-col bg-slate-100">
      <header className="flex items-center justify-between border-b border-slate-200 bg-surface px-4 py-3">
        <div className="flex items-center gap-2">
          <Inbox className="size-5 text-brand-600" />
          <h1 className="font-semibold">Dev mailbox</h1>
          <span className="hidden text-sm text-slate-500 sm:inline">
            — emails aren't really sent in development
          </span>
        </div>
        <Link to="/" className="text-sm font-semibold text-brand-600">
          Back to app
        </Link>
      </header>
      {mailbox.isLoading ? (
        <LoadingBlock />
      ) : mailbox.isError ? (
        <ErrorBlock
          error={
            new Error(
              'The dev mailbox is only available in development with EMAIL_TRANSPORT=console.',
            )
          }
        />
      ) : messages.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title="No emails yet"
          description="Sign up, invite someone or publish a schedule."
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <ul className="max-h-64 shrink-0 overflow-y-auto border-b border-slate-200 bg-surface md:max-h-none md:w-96 md:border-r md:border-b-0">
            {messages.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(m.id)}
                  className={cx(
                    'w-full border-b border-slate-100 px-4 py-3 text-left hover:bg-slate-50',
                    selected?.id === m.id && 'bg-brand-50 hover:bg-brand-50',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-medium text-slate-500">{m.toEmail}</p>
                    <span className="shrink-0 text-[11px] text-slate-400">
                      {formatRelative(m.createdAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-sm font-semibold text-slate-900">
                    {m.subject}
                  </p>
                  <div className="mt-1 flex gap-1.5">
                    <Badge>{m.kind.replace(/_/g, ' ')}</Badge>
                    <Badge
                      tone={m.status === 'sent' ? 'green' : m.status === 'failed' ? 'red' : 'amber'}
                    >
                      {m.status}
                    </Badge>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {selected && (
            <iframe
              key={selected.id}
              title={selected.subject}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              srcDoc={selected.html.replace('<head>', '<head><base target="_blank">')}
              className="min-h-0 flex-1 bg-white"
            />
          )}
        </div>
      )}
    </div>
  );
}
