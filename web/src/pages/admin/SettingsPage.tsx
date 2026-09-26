import { HOLIDAY_REGIONS, holidaysBetween } from '@shared/holidays';
import { addDays, formatDay, todayIn } from '@shared/time';
import type { HolidayRegion, OrgSettings, Team, TimeFormat, TimeOffType } from '@shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { keys, useSettings, useTeams, useTimeOffTypes } from '../../api/queries';
import { TimezoneSelect } from '../../components/TimezoneSelect';
import { Button } from '../../components/ui/Button';
import { Field, FormError, Input, Select, Toggle } from '../../components/ui/Form';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import {
  Badge,
  Card,
  CardHeader,
  ColorDot,
  ColorPicker,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
} from '../../components/ui/Misc';
import { PALETTE } from '../../lib/colors';
import { fieldErrors, formMessage } from '../../lib/forms';

export default function SettingsPage() {
  const settings = useSettings();
  if (settings.isLoading) return <LoadingBlock />;
  if (settings.isError || !settings.data)
    return <ErrorBlock error={settings.error} onRetry={() => void settings.refetch()} />;
  return (
    <div className="max-w-3xl">
      <PageHeader title="Settings" />
      <div className="space-y-6">
        <OrgSettingsCard settings={settings.data} />
        <TeamsCard />
        <TimeOffTypesCard />
      </div>
    </div>
  );
}

function OrgSettingsCard({ settings }: { settings: OrgSettings }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ ...settings, domains: settings.allowedDomains.join(', ') });
  const save = useMutation({
    mutationFn: () =>
      api.patch<OrgSettings>('/admin/settings', {
        orgName: form.orgName,
        timezone: form.timezone,
        weekStartsOn: form.weekStartsOn,
        reminderHours: form.reminderHours,
        selfSignup: form.selfSignup,
        allowedDomains: form.domains.split(/[\s,]+/).filter(Boolean),
        holidayRegion: form.holidayRegion,
        timeFormat: form.timeFormat,
      }),
    onSuccess: (s) => {
      queryClient.setQueryData(keys.settings, s);
      setForm({ ...s, domains: s.allowedDomains.join(', ') });
      void queryClient.invalidateQueries({ queryKey: keys.bootstrap });
      toast.success('Settings saved');
    },
  });
  const errors = fieldErrors(save.error);
  const upcoming = useMemo(() => {
    const today = todayIn(form.timezone);
    return [...holidaysBetween(form.holidayRegion, today, addDays(today, 365)).entries()]
      .flatMap(([date, list]) =>
        list.filter((h) => !h.observed).map((h) => ({ date, name: h.name })),
      )
      .slice(0, 3);
  }, [form.holidayRegion, form.timezone]);
  return (
    <Card>
      <CardHeader title="Organization" />
      <form
        className="space-y-5 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <FormError message={formMessage(save.error, ['orgName', 'timezone', 'allowedDomains'])} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Organization name" error={errors.orgName}>
            <Input
              required
              value={form.orgName}
              onChange={(e) => setForm({ ...form, orgName: e.target.value })}
            />
          </Field>
          <Field label="Weeks start on">
            <Select
              value={form.weekStartsOn}
              onChange={(e) => setForm({ ...form, weekStartsOn: Number(e.target.value) as 0 | 1 })}
            >
              <option value={1}>Monday</option>
              <option value={0}>Sunday</option>
            </Select>
          </Field>
        </div>
        <Field
          label="Time zone"
          hint="Schedules are built in this zone. Each person can view times in their own zone."
          error={errors.timezone}
        >
          <TimezoneSelect
            value={form.timezone}
            onChange={(timezone) => setForm({ ...form, timezone })}
          />
        </Field>
        <Field
          label="Time format"
          hint="The default for everyone, and for emails. People can pick their own in their profile."
        >
          <Select
            value={form.timeFormat}
            onChange={(e) => setForm({ ...form, timeFormat: e.target.value as TimeFormat })}
          >
            <option value="12h">12-hour (3:00 PM)</option>
            <option value="24h">24-hour (15:00)</option>
          </Select>
        </Field>
        <Field
          label="Statutory holidays"
          hint={
            upcoming.length
              ? `Shown on every calendar. Next: ${upcoming.map((h) => `${h.name} (${formatDay(h.date)})`).join(', ')}.`
              : 'Holidays are hidden from the calendars.'
          }
        >
          <Select
            value={form.holidayRegion}
            onChange={(e) => setForm({ ...form, holidayRegion: e.target.value as HolidayRegion })}
          >
            {HOLIDAY_REGIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Confirmation reminders"
          hint="Email people once if they haven't confirmed a published shift."
        >
          <Select
            value={form.reminderHours}
            onChange={(e) => setForm({ ...form, reminderHours: Number(e.target.value) })}
          >
            <option value={0}>Don't send reminders</option>
            <option value={12}>After 12 hours</option>
            <option value={24}>After 24 hours</option>
            <option value={48}>After 2 days</option>
            <option value={72}>After 3 days</option>
            {![0, 12, 24, 48, 72].includes(form.reminderHours) && (
              <option value={form.reminderHours}>After {form.reminderHours} hours</option>
            )}
          </Select>
        </Field>
        <div className="space-y-3 rounded-lg bg-slate-50 p-4">
          <Toggle
            checked={form.selfSignup}
            onChange={(selfSignup) => setForm({ ...form, selfSignup })}
            label="Let people create their own account"
            description="They confirm their email, then start without a tier until you assign one. Otherwise, people join by invite only."
          />
          {form.selfSignup && (
            <Field
              label="Only allow these email domains"
              optional
              hint="Comma-separated, e.g. company.com. Leave empty to allow any address."
              error={errors.allowedDomains}
            >
              <Input
                value={form.domains}
                onChange={(e) => setForm({ ...form, domains: e.target.value })}
                placeholder="company.com"
              />
            </Field>
          )}
        </div>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save settings
          </Button>
        </div>
      </form>
    </Card>
  );
}

function TeamsCard() {
  const teams = useTeams();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Team | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Team | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.teams });
    void queryClient.invalidateQueries({ queryKey: keys.people });
  };
  const remove = useMutation({
    mutationFn: (team: Team) => api.delete(`/teams/${team.id}`),
    onSuccess: () => {
      toast.success('Team deleted');
      setDeleting(null);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Card>
      <CardHeader
        title="Teams"
        description="Optional groups (e.g. East / West) people can filter the team schedule by."
        actions={
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            Add team
          </Button>
        }
      />
      {teams.data?.length ? (
        <ul className="divide-y divide-slate-100">
          {teams.data.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-5 py-2.5">
              <p className="flex-1 text-sm font-medium text-slate-900">{t.name}</p>
              <span className="text-xs text-slate-500">
                {t.memberCount} {t.memberCount === 1 ? 'person' : 'people'}
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Rename ${t.name}`}
                onClick={() => setEditing(t)}
              >
                <Pencil className="size-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Delete ${t.name}`}
                onClick={() => setDeleting(t)}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-5 py-4 text-sm text-slate-500">No teams. Everyone is shown together.</p>
      )}
      {editing && (
        <TeamDialog
          team={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          confirmLabel="Delete team"
          danger
          loading={remove.isPending}
          onConfirm={() => remove.mutate(deleting)}
          onClose={() => setDeleting(null)}
        >
          People in this team won't be deleted — they just won't have a team.
        </ConfirmDialog>
      )}
    </Card>
  );
}

function TeamDialog({
  team,
  onClose,
  onSaved,
}: {
  team: Team | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(team?.name ?? '');
  const save = useMutation({
    mutationFn: () =>
      team ? api.patch(`/teams/${team.id}`, { name }) : api.post('/teams', { name }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Modal
      title={team ? 'Rename team' : 'Add team'}
      size="sm"
      onClose={onClose}
      onSubmit={() => save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <FormError message={formMessage(save.error, ['name'])} />
      <Field label="Name" error={fieldErrors(save.error).name}>
        <Input
          required
          autoFocus
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
    </Modal>
  );
}

function TimeOffTypesCard() {
  const types = useTimeOffTypes(true);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<TimeOffType | 'new' | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['time-off-types'] });
  const toggleArchive = useMutation({
    mutationFn: (t: TimeOffType) => api.patch(`/time-off-types/${t.id}`, { archived: !t.archived }),
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (t: TimeOffType) => api.delete(`/time-off-types/${t.id}`),
    onSuccess: () => {
      toast.success('Deleted');
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Card>
      <CardHeader
        title="Time-off types"
        description="What people can pick when they request time off."
        actions={
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            Add type
          </Button>
        }
      />
      <ul className="divide-y divide-slate-100">
        {types.data?.map((t) => (
          <li key={t.id} className="flex items-center gap-3 px-5 py-2.5">
            <ColorDot color={t.color} className="size-3" />
            <p
              className={
                t.archived
                  ? 'flex-1 text-sm text-slate-400 line-through'
                  : 'flex-1 text-sm font-medium text-slate-900'
              }
            >
              {t.name}
            </p>
            <Badge tone={t.paid ? 'green' : 'gray'}>{t.paid ? 'Paid' : 'Unpaid'}</Badge>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Edit ${t.name}`}
              onClick={() => setEditing(t)}
            >
              <Pencil className="size-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t.archived ? `Restore ${t.name}` : `Archive ${t.name}`}
              title={t.archived ? 'Restore' : 'Archive (hide from requests)'}
              onClick={() => toggleArchive.mutate(t)}
            >
              {t.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Delete ${t.name}`}
              title="Delete (only if never used)"
              onClick={() => remove.mutate(t)}
            >
              <Trash2 className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
      {editing && (
        <TimeOffTypeDialog
          type={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
    </Card>
  );
}

function TimeOffTypeDialog({
  type,
  onClose,
  onSaved,
}: {
  type: TimeOffType | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(type?.name ?? '');
  const [color, setColor] = useState(type?.color ?? PALETTE[3]!);
  const [paid, setPaid] = useState(type?.paid ?? true);
  const save = useMutation({
    mutationFn: () =>
      type
        ? api.patch(`/time-off-types/${type.id}`, { name, color, paid })
        : api.post('/time-off-types', { name, color, paid }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Modal
      title={type ? `Edit ${type.name}` : 'Add time-off type'}
      size="sm"
      onClose={onClose}
      onSubmit={() => save.mutate()}
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
        <FormError message={formMessage(save.error, ['name'])} />
        <Field label="Name" error={fieldErrors(save.error).name}>
          <Input
            required
            autoFocus
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Bereavement"
          />
        </Field>
        <ColorPicker value={color} onChange={setColor} />
        <Toggle
          checked={paid}
          onChange={setPaid}
          label="Paid time off"
          description="Shown to people and admins for reference."
        />
      </div>
    </Modal>
  );
}
