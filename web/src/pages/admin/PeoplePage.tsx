import { formatRelative } from '@shared/time';
import type { Person, Role, Team, Tier, UserStatus } from '@shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CalendarX,
  Ellipsis,
  MailPlus,
  Pencil,
  Search,
  Trash2,
  UserCheck,
  UserPlus,
  UserX,
  Users,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { api, errorMessage } from '../../api/client';
import { keys, usePeople, useTeams, useTiers } from '../../api/queries';
import { TimezoneSelect } from '../../components/TimezoneSelect';
import { Button } from '../../components/ui/Button';
import { Field, FormError, Input, Select, Textarea } from '../../components/ui/Form';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import {
  Avatar,
  Badge,
  Card,
  ColorDot,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Menu,
  PageHeader,
  Tabs,
  type Tone,
} from '../../components/ui/Misc';
import { fieldErrors, formMessage } from '../../lib/forms';
import { useBootstrapData, useCurrentUser } from '../../lib/session';
import { zoneLabel } from '../../lib/timezones';

const STATUS: Record<UserStatus, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'green' },
  invited: { label: 'Invite sent', tone: 'amber' },
  deactivated: { label: 'Deactivated', tone: 'gray' },
};

type Pending =
  | { kind: 'edit'; person: Person }
  | { kind: 'deactivate'; person: Person }
  | { kind: 'clear'; person: Person }
  | { kind: 'delete'; person: Person };

export default function PeoplePage() {
  const me = useCurrentUser();
  const people = usePeople();
  const tiers = useTiers();
  const teams = useTeams();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const inviting = params.get('invite') === '1';
  const setInviting = (open: boolean) => setParams(open ? { invite: '1' } : {}, { replace: true });
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'current' | UserStatus>('current');
  const [pending, setPending] = useState<Pending | null>(null);

  const tierById = useMemo(() => new Map((tiers.data ?? []).map((t) => [t.id, t])), [tiers.data]);
  const teamById = useMemo(() => new Map((teams.data ?? []).map((t) => [t.id, t])), [teams.data]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.people });
    void queryClient.invalidateQueries({ queryKey: keys.tiers });
    void queryClient.invalidateQueries({ queryKey: keys.teams });
  };

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch<Person>(`/users/${id}`, body),
    onSuccess: (p, { body }) => {
      if ('active' in body)
        toast.success(body.active ? `${p.name} reactivated` : `${p.name} deactivated`);
      setPending(null);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const resend = useMutation({
    mutationFn: (p: Person) => api.post<Person>(`/users/${p.id}/resend-invite`),
    onSuccess: (p) => toast.success(`New invite sent to ${p.email}`),
    onError: (e) => toast.error(e.message),
  });
  const clearShifts = useMutation({
    mutationFn: (p: Person) =>
      api.delete<{ removed: number; pendingRemoval: number }>(`/users/${p.id}/shifts`),
    onSuccess: (r, p) => {
      toast.success(
        r.pendingRemoval
          ? `${p.name} is off all shifts. Publish to tell the team.`
          : `${p.name} is off all shifts`,
      );
      setPending(null);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (p: Person) => api.delete(`/users/${p.id}`),
    onSuccess: () => {
      toast.success('Removed');
      setPending(null);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const counts = { current: 0, active: 0, invited: 0, deactivated: 0 };
  for (const p of people.data ?? []) {
    counts[p.status]++;
    if (p.status !== 'deactivated') counts.current++;
  }
  const q = search.trim().toLowerCase();
  const visible = (people.data ?? []).filter(
    (p) =>
      (statusFilter === 'current' ? p.status !== 'deactivated' : p.status === statusFilter) &&
      (!tierFilter || (tierFilter === 'none' ? !p.tierId : p.tierId === tierFilter)) &&
      (!q || p.name.toLowerCase().includes(q) || p.email.includes(q)),
  );

  return (
    <>
      <PageHeader
        title="People"
        description="Invite your team, and put each person in a tier so they show up on the schedule."
        actions={
          <Button
            variant="primary"
            icon={<UserPlus className="size-4" />}
            onClick={() => setInviting(true)}
          >
            Invite people
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: 'current', label: `Everyone (${counts.current})` },
            { value: 'invited', label: `Invited (${counts.invited})` },
            { value: 'deactivated', label: `Deactivated (${counts.deactivated})` },
          ]}
        />
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
          <Input
            aria-label="Search people"
            placeholder="Search name or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="w-44">
          <Select
            aria-label="Tier"
            value={tierFilter}
            onChange={(e) => setTierFilter(e.target.value)}
          >
            <option value="">All tiers</option>
            {tiers.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
            <option value="none">No tier</option>
          </Select>
        </div>
      </div>

      {people.isLoading ? (
        <LoadingBlock />
      ) : people.isError ? (
        <ErrorBlock error={people.error} onRetry={() => void people.refetch()} />
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Users />}
            title="No one matches"
            description="Try another filter, or invite someone new."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {visible.map((p) => {
              const tier = p.tierId ? tierById.get(p.tierId) : undefined;
              const team = p.teamId ? teamById.get(p.teamId) : undefined;
              return (
                <li key={p.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                  <Avatar name={p.name} />
                  <div className="min-w-0 flex-1 sm:grid sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-center sm:gap-4">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 truncate text-sm font-semibold text-slate-900">
                        <span className="truncate">{p.name}</span>
                        {p.role === 'admin' && <Badge tone="brand">Admin</Badge>}
                        {p.id === me.id && <Badge>You</Badge>}
                      </p>
                      <p className="truncate text-xs text-slate-500">{p.email}</p>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 sm:mt-0">
                      {tier ? (
                        <span className="flex items-center gap-1.5">
                          <ColorDot color={tier.color} /> {tier.name}
                        </span>
                      ) : (
                        <span className="text-amber-700">No tier</span>
                      )}
                      {team && <span className="text-slate-500">{team.name}</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 sm:mt-0">
                      <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>
                      <span className="hidden text-xs text-slate-400 lg:inline">
                        {p.lastLoginAt
                          ? `seen ${formatRelative(p.lastLoginAt)}`
                          : p.status === 'invited'
                            ? `invited ${formatRelative(p.createdAt)}`
                            : ''}
                      </span>
                    </div>
                  </div>
                  <Menu
                    label={`Actions for ${p.name}`}
                    trigger={<Ellipsis className="size-4" />}
                    items={[
                      {
                        label: 'Edit',
                        icon: <Pencil />,
                        onSelect: () => setPending({ kind: 'edit', person: p }),
                      },
                      ...(p.status === 'invited'
                        ? [
                            {
                              label: 'Resend invite',
                              icon: <MailPlus />,
                              onSelect: () => resend.mutate(p),
                            },
                          ]
                        : []),
                      p.status === 'deactivated'
                        ? {
                            label: 'Reactivate',
                            icon: <UserCheck />,
                            onSelect: () => patch.mutate({ id: p.id, body: { active: true } }),
                          }
                        : {
                            label: 'Deactivate',
                            icon: <UserX />,
                            disabled: p.id === me.id,
                            onSelect: () => setPending({ kind: 'deactivate', person: p }),
                          },
                      ...(p.shiftCount > 0
                        ? [
                            {
                              label: 'Remove all shifts',
                              icon: <CalendarX />,
                              danger: true,
                              onSelect: () => setPending({ kind: 'clear', person: p }),
                            },
                          ]
                        : []),
                      ...(p.shiftCount === 0 && p.id !== me.id
                        ? [
                            {
                              label: 'Delete',
                              icon: <Trash2 />,
                              danger: true,
                              onSelect: () => setPending({ kind: 'delete', person: p }),
                            },
                          ]
                        : []),
                    ]}
                  />
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {inviting && (
        <InviteDialog
          tiers={tiers.data ?? []}
          teams={teams.data ?? []}
          defaultTierId={tierFilter && tierFilter !== 'none' ? tierFilter : ''}
          onClose={() => setInviting(false)}
          onDone={refresh}
        />
      )}
      {pending?.kind === 'edit' && (
        <EditPersonDialog
          person={pending.person}
          tiers={tiers.data ?? []}
          teams={teams.data ?? []}
          onClose={() => setPending(null)}
          onSaved={refresh}
        />
      )}
      {pending?.kind === 'deactivate' && (
        <ConfirmDialog
          title={`Deactivate ${pending.person.name}?`}
          confirmLabel="Deactivate"
          danger
          loading={patch.isPending}
          onConfirm={() => patch.mutate({ id: pending.person.id, body: { active: false } })}
          onClose={() => setPending(null)}
        >
          They'll be signed out and can't sign in. Their past shifts stay on the schedule, and you
          can reactivate them later.
        </ConfirmDialog>
      )}
      {pending?.kind === 'clear' && (
        <ConfirmDialog
          title={`Remove all shifts for ${pending.person.name}?`}
          confirmLabel="Remove all shifts"
          danger
          loading={clearShifts.isPending}
          onConfirm={() => clearShifts.mutate(pending.person)}
          onClose={() => setPending(null)}
        >
          They'll come off all {pending.person.shiftCount} of their shifts, past and future. Shifts
          the team can already see stay until you publish the change.
        </ConfirmDialog>
      )}
      {pending?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete ${pending.person.name}?`}
          confirmLabel="Delete"
          danger
          loading={remove.isPending}
          onConfirm={() => remove.mutate(pending.person)}
          onClose={() => setPending(null)}
        >
          This removes their account and time-off history. People with shifts can only be
          deactivated.
        </ConfirmDialog>
      )}
    </>
  );
}

function TierTeamFields({
  tiers,
  teams,
  tierId,
  teamId,
  onChange,
}: {
  tiers: Tier[];
  teams: Team[];
  tierId: string;
  teamId: string;
  onChange: (patch: { tierId?: string; teamId?: string }) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Tier" hint="Groups them on the schedule.">
        <Select value={tierId} onChange={(e) => onChange({ tierId: e.target.value })}>
          <option value="">No tier yet</option>
          {tiers.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Team" optional>
        <Select value={teamId} onChange={(e) => onChange({ teamId: e.target.value })}>
          <option value="">No team</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

function RoleField({ value, onChange }: { value: Role; onChange: (role: Role) => void }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-slate-700">Role</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {(
          [
            ['member', 'Team member', 'Sees schedules, confirms shifts, requests time off'],
            ['admin', 'Admin', 'Also builds & publishes schedules and manages people'],
          ] as const
        ).map(([role, title, desc]) => (
          <label
            key={role}
            className="flex cursor-pointer gap-2.5 rounded-lg border border-slate-200 p-3 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50/50"
          >
            <input
              type="radio"
              name="role"
              className="mt-0.5 accent-brand-600"
              checked={value === role}
              onChange={() => onChange(role)}
            />
            <span>
              <span className="block text-sm font-medium text-slate-900">{title}</span>
              <span className="block text-xs text-slate-500">{desc}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Parse "Name, email" / "Name <email>" / "email" lines for bulk invites. */
function parseInviteLines(text: string): { name: string; email: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const angle = /^(.*)<([^>]+)>$/.exec(line);
      if (angle) return { name: angle[1]!.trim().replace(/,$/, ''), email: angle[2]!.trim() };
      const parts = line
        .split(/[,;\t]/)
        .map((p) => p.trim())
        .filter(Boolean);
      const email = parts.find((p) => p.includes('@')) ?? '';
      const name =
        parts.filter((p) => p !== email).join(' ') || email.split('@')[0]!.replace(/[._-]+/g, ' ');
      return { name, email };
    });
}

function InviteDialog({
  tiers,
  teams,
  defaultTierId,
  onClose,
  onDone,
}: {
  tiers: Tier[];
  teams: Team[];
  defaultTierId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { signIn } = useBootstrapData();
  const [mode, setMode] = useState<'one' | 'many'>('one');
  const [form, setForm] = useState({
    name: '',
    email: '',
    role: 'member' as Role,
    tierId: defaultTierId,
    teamId: '',
  });
  const [bulk, setBulk] = useState('');
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);
  const invite = useMutation({
    mutationFn: async () => {
      const common = { role: form.role, tierId: form.tierId || null, teamId: form.teamId || null };
      if (mode === 'one') {
        await api.post<Person>('/users', { ...common, name: form.name, email: form.email });
        return { sent: 1, failed: [] as string[] };
      }
      const failed: string[] = [];
      let sent = 0;
      for (const row of parseInviteLines(bulk)) {
        try {
          await api.post<Person>('/users', { ...common, ...row });
          sent++;
        } catch (e) {
          failed.push(`${row.email || row.name}: ${errorMessage(e)}`);
        }
      }
      return { sent, failed };
    },
    onSuccess: ({ sent, failed }) => {
      onDone();
      if (sent) toast.success(`${sent} invite${sent === 1 ? '' : 's'} sent`);
      if (failed.length) setBulkErrors(failed);
      else onClose();
    },
  });
  const errors = fieldErrors(invite.error);
  const rows = parseInviteLines(bulk);

  return (
    <Modal
      title="Invite people"
      description={
        signIn === 'google'
          ? "They'll get an email with a link to the schedule, and sign in with their Google account."
          : "They'll get an email to set a password. Their address is confirmed when they accept."
      }
      onClose={onClose}
      onSubmit={() => invite.mutate()}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            loading={invite.isPending}
            disabled={mode === 'many' && rows.length === 0}
          >
            {mode === 'one'
              ? 'Send invite'
              : `Send ${rows.length || ''} invite${rows.length === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Tabs
          value={mode}
          onChange={setMode}
          options={[
            { value: 'one', label: 'One person' },
            { value: 'many', label: 'Several at once' },
          ]}
        />
        <FormError message={formMessage(invite.error, ['name', 'email'])} />
        {bulkErrors.length > 0 && (
          <div
            role="alert"
            className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200"
          >
            <p className="font-medium">Some invites weren't sent:</p>
            <ul className="mt-1 list-disc pl-5">
              {bulkErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}
        {mode === 'one' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" error={errors.name}>
              <Input
                required
                autoFocus
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Work email" error={errors.email}>
              <Input
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>
          </div>
        ) : (
          <Field
            label="People"
            hint={`One per line, like “Priya Patel, priya@company.com”. ${rows.length} detected.`}
          >
            <Textarea
              rows={6}
              autoFocus
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
              placeholder={
                'Priya Patel, priya@company.com\nSam Chen <sam@company.com>\njordan.lee@company.com'
              }
            />
          </Field>
        )}
        <TierTeamFields
          tiers={tiers}
          teams={teams}
          tierId={form.tierId}
          teamId={form.teamId}
          onChange={(p) => setForm({ ...form, ...p })}
        />
        <RoleField value={form.role} onChange={(role) => setForm({ ...form, role })} />
      </div>
    </Modal>
  );
}

function EditPersonDialog({
  person,
  tiers,
  teams,
  onClose,
  onSaved,
}: {
  person: Person;
  tiers: Tier[];
  teams: Team[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { org } = useBootstrapData();
  const [form, setForm] = useState({
    name: person.name,
    email: person.email,
    role: person.role,
    tierId: person.tierId ?? '',
    teamId: person.teamId ?? '',
    timezone: person.timezone ?? '',
  });
  const save = useMutation({
    mutationFn: () =>
      api.patch<Person>(`/users/${person.id}`, {
        name: form.name,
        ...(person.status === 'invited' ? { email: form.email } : {}),
        role: form.role,
        tierId: form.tierId || null,
        teamId: form.teamId || null,
        timezone: form.timezone || null,
      }),
    onSuccess: (p) => {
      toast.success(p.email !== person.email ? `Saved — a new invite went to ${p.email}` : 'Saved');
      onSaved();
      onClose();
    },
  });
  const errors = fieldErrors(save.error);
  return (
    <Modal
      title={`Edit ${person.name}`}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={formMessage(save.error, ['name', 'email'])} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" error={errors.name}>
            <Input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field
            label="Email"
            error={errors.email}
            hint={
              person.status === 'invited'
                ? 'Fixing a typo sends a fresh invite.'
                : "Can't be changed after they've joined."
            }
          >
            <Input
              type="email"
              required
              disabled={person.status !== 'invited'}
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
        </div>
        <TierTeamFields
          tiers={tiers}
          teams={teams}
          tierId={form.tierId}
          teamId={form.teamId}
          onChange={(p) => setForm({ ...form, ...p })}
        />
        <RoleField value={form.role} onChange={(role) => setForm({ ...form, role })} />
        <Field label="Time zone" hint="Times in their emails and schedule use this zone.">
          <TimezoneSelect
            value={form.timezone}
            onChange={(timezone) => setForm({ ...form, timezone })}
            defaultOption={`Organization default — ${zoneLabel(org.timezone)}`}
          />
        </Field>
      </div>
    </Modal>
  );
}
