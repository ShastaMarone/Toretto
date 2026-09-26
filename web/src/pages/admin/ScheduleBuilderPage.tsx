import {
  addDays,
  eachDay,
  formatDateRange,
  formatDay,
  formatHours,
  formatTimestamp,
  isWeekend,
  localDate,
  moveShiftToDate,
  todayIn,
  type ISODate,
} from '@shared/time';
import type { BuilderShift, PublishResult, ScheduleDetail, ScheduleSummary } from '@shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { ArrowLeft, Ellipsis, Pencil, Plus, Send, Trash2, Undo2, UserPlus } from 'lucide-react';
import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { keys, usePeople, useSchedule } from '../../api/queries';
import {
  ShiftDialog,
  type ShiftDraft,
  type ShiftPayload,
} from '../../components/schedule/ShiftDialog';
import { ScheduleLegend, ShiftChip, TimeOffChip } from '../../components/schedule/ShiftChip';
import { Button, ButtonLink } from '../../components/ui/Button';
import { Field, FormError, Input, Select } from '../../components/ui/Form';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import {
  Avatar,
  Card,
  ColorDot,
  ErrorBlock,
  LoadingBlock,
  Menu,
  Tabs,
} from '../../components/ui/Misc';
import { StatusBadge } from '../../components/schedule/StatusBadge';
import { cx } from '../../lib/cx';
import { fieldErrors, formMessage } from '../../lib/forms';
import {
  draftFromShift,
  groupByUserDay,
  scheduleTitle,
  timeOffByUserDay,
  totalHours,
} from '../../lib/schedule';
import { useBootstrapData } from '../../lib/session';
import { zoneLabel } from '../../lib/timezones';

type DialogState = { mode: 'create'; draft: ShiftDraft } | { mode: 'edit'; shift: BuilderShift };

export default function ScheduleBuilderPage() {
  const { id = '' } = useParams();
  const query = useSchedule(id);
  if (query.isLoading) return <LoadingBlock />;
  if (query.isError || !query.data)
    return <ErrorBlock error={query.error} onRetry={() => void query.refetch()} />;
  return <Builder detail={query.data} />;
}

function Builder({ detail }: { detail: ScheduleDetail }) {
  const { org } = useBootstrapData();
  const tz = org.timezone; // schedules are built in the organization's zone
  const { schedule } = detail;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const people = usePeople();
  const queryKey = keys.schedule(schedule.id);

  const weeks = useMemo(() => {
    const all = eachDay(schedule.startDate, schedule.endDate);
    const chunks: ISODate[][] = [];
    for (let i = 0; i < all.length; i += 7) chunks.push(all.slice(i, i + 7));
    return chunks;
  }, [schedule.startDate, schedule.endDate]);
  const allDays = useMemo(() => weeks.flat(), [weeks]);
  const [weekIndex, setWeekIndex] = useState(0);
  const days = weeks[Math.min(weekIndex, weeks.length - 1)] ?? [];
  const today = todayIn(tz);

  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [extraRows, setExtraRows] = useState<string[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [showPublish, setShowPublish] = useState(false);
  const [showDiscard, setShowDiscard] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({ queryKey: keys.schedules });
    void queryClient.invalidateQueries({ queryKey: keys.overview });
  };

  // ---- data shaping -------------------------------------------------------
  const rows = useMemo(() => {
    const byId = new Map(detail.members.map((m) => [m.id, m]));
    for (const userId of extraRows) {
      const person = people.data?.find((p) => p.id === userId);
      if (person && !byId.has(userId)) {
        byId.set(userId, {
          id: person.id,
          name: person.name,
          tierId: person.tierId,
          teamId: person.teamId,
          active: true,
        });
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [detail.members, extraRows, people.data]);
  const byUserDay = useMemo(() => groupByUserDay(detail.shifts, tz), [detail.shifts, tz]);
  const removedByUserDay = useMemo(
    () => groupByUserDay(detail.removedShifts, tz),
    [detail.removedShifts, tz],
  );
  const offByUserDay = useMemo(
    () => timeOffByUserDay(detail.timeOff, allDays),
    [detail.timeOff, allDays],
  );
  const weekShifts = detail.shifts.filter((s) => days.includes(localDate(s.startTime, tz)));
  const labelsById = new Map(detail.labels.map((l) => [l.id, l]));

  // ---- mutations ------------------------------------------------------------
  const create = useMutation({
    mutationFn: (payload: ShiftPayload) =>
      api.post<BuilderShift>(`/schedules/${schedule.id}/shifts`, payload),
    onSuccess: () => {
      setDialog(null);
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ shiftId, payload }: { shiftId: string; payload: Partial<ShiftPayload> }) =>
      api.patch<BuilderShift>(`/shifts/${shiftId}`, payload),
    onSuccess: () => {
      setDialog(null);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (shiftId: string) => api.delete<{ pendingRemoval: boolean }>(`/shifts/${shiftId}`),
    onSuccess: ({ pendingRemoval }) => {
      setDialog(null);
      if (pendingRemoval)
        toast('Shift will be removed when you publish', {
          description: 'The team still sees it until then.',
        });
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const restore = useMutation({
    mutationFn: (shiftId: string) => api.post<BuilderShift>(`/shifts/${shiftId}/restore`),
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  });
  const move = useMutation({
    mutationFn: ({
      shift,
      userId,
      date,
      copy,
    }: {
      shift: BuilderShift;
      userId: string;
      date: ISODate;
      copy: boolean;
    }) => {
      const times = moveShiftToDate(shift.startTime, shift.endTime, date, tz);
      return copy
        ? api.post<BuilderShift>(`/schedules/${schedule.id}/shifts`, {
            userId,
            labelId: shift.labelId,
            notes: shift.notes,
            ...times,
          })
        : api.patch<BuilderShift>(`/shifts/${shift.id}`, { userId, ...times });
    },
    onMutate: async ({ shift, userId, date, copy }) => {
      if (copy) return { previous: undefined };
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ScheduleDetail>(queryKey);
      const times = moveShiftToDate(shift.startTime, shift.endTime, date, tz);
      queryClient.setQueryData<ScheduleDetail>(queryKey, (d) =>
        d
          ? {
              ...d,
              shifts: d.shifts.map((s) => (s.id === shift.id ? { ...s, userId, ...times } : s)),
            }
          : d,
      );
      return { previous };
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(queryKey, ctx.previous);
      toast.error(e.message);
    },
    onSettled: refresh,
  });
  const publish = useMutation({
    mutationFn: () => api.post<PublishResult>(`/schedules/${schedule.id}/publish`),
    onSuccess: (r) => {
      setShowPublish(false);
      const changed = r.added + r.updated + r.removed;
      toast.success(changed ? 'Schedule published' : 'Nothing new to publish', {
        description: r.emailsQueued
          ? `Emailing ${r.emailsQueued} ${r.emailsQueued === 1 ? 'person' : 'people'} so they can confirm.`
          : changed
            ? 'No one needed an email (all changes were in the past).'
            : undefined,
      });
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const discard = useMutation({
    mutationFn: () => api.post<ScheduleDetail>(`/schedules/${schedule.id}/discard-changes`),
    onSuccess: (d) => {
      setShowDiscard(false);
      queryClient.setQueryData(queryKey, d);
      toast.success('Unpublished changes discarded');
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const destroy = useMutation({
    mutationFn: () => api.delete<{ notified: number }>(`/schedules/${schedule.id}`),
    onSuccess: ({ notified }) => {
      toast.success('Schedule deleted', {
        description: notified
          ? `Told ${notified} ${notified === 1 ? 'person' : 'people'} their shifts were cancelled.`
          : undefined,
      });
      void queryClient.invalidateQueries({ queryKey: keys.schedules });
      navigate('/admin/schedules', { replace: true });
    },
    onError: (e) => toast.error(e.message),
  });

  // ---- drag and drop ----------------------------------------------------------
  const onDragStart = (shift: BuilderShift) => (e: DragEvent<HTMLElement>) => {
    e.dataTransfer.setData('text/plain', shift.id);
    e.dataTransfer.effectAllowed = 'copyMove';
    setDraggingId(shift.id);
  };
  const onDragEnd = () => {
    setDraggingId(null);
    setDropKey(null);
  };
  const cellDrop = (userId: string, date: ISODate) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!draggingId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.altKey || e.ctrlKey || e.metaKey ? 'copy' : 'move';
      setDropKey(`${userId}|${date}`);
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropKey(null);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      const shift = detail.shifts.find(
        (s) => s.id === (e.dataTransfer.getData('text/plain') || draggingId),
      );
      const copy = e.altKey || e.ctrlKey || e.metaKey;
      onDragEnd();
      if (!shift) return;
      if (!copy && shift.userId === userId && localDate(shift.startTime, tz) === date) return;
      move.mutate({ shift, userId, date, copy });
    },
  });

  // ---- derived summary ---------------------------------------------------------
  const affectedPeople = useMemo(() => {
    const ids = new Set<string>();
    for (const s of [...detail.shifts, ...detail.removedShifts]) {
      if (schedule.status === 'draft' || s.changeState !== 'unchanged') {
        if (s.changeState !== 'removed') ids.add(s.userId);
        if (s.published) ids.add(s.published.userId);
      }
    }
    return ids.size;
  }, [detail.shifts, detail.removedShifts, schedule.status]);
  const hasChanges = detail.changes.total > 0;
  const published = schedule.status === 'published';
  const openCreate = (userId: string, date: ISODate) =>
    setDialog({
      mode: 'create',
      draft: { userId, date, start: '09:00', end: '17:00', labelId: null, notes: '' },
    });
  const addableRows = (people.data ?? []).filter(
    (p) => p.status !== 'deactivated' && !rows.some((r) => r.id === p.id),
  );

  return (
    <>
      <div className="mb-5">
        <ButtonLink
          to="/admin/schedules"
          variant="ghost"
          size="sm"
          icon={<ArrowLeft className="size-4" />}
          className="-ml-3 mb-2"
        >
          Schedules
        </ButtonLink>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <ColorDot color={schedule.tierColor} className="size-3" />
              <span className="text-sm font-semibold text-slate-500">{schedule.tierName}</span>
              <StatusBadge schedule={schedule} />
            </div>
            <h1 className="mt-1 text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
              {scheduleTitle(schedule)}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              {schedule.name && `${formatDateRange(schedule.startDate, schedule.endDate)} · `}
              {detail.shifts.length} shift{detail.shifts.length === 1 ? '' : 's'} ·{' '}
              {formatHours(totalHours(detail.shifts))}
              {published &&
                ` · ${schedule.confirmedCount}/${schedule.confirmedCount + schedule.pendingCount} confirmed`}
              {schedule.publishedAt &&
                ` · published ${formatTimestamp(schedule.publishedAt, tz)}${schedule.publishedByName ? ` by ${schedule.publishedByName}` : ''}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {published && hasChanges && (
              <Button
                icon={<Undo2 className="size-4" />}
                onClick={() => setShowDiscard(true)}
                aria-label="Discard changes"
              >
                <span className="hidden sm:inline">Discard changes</span>
              </Button>
            )}
            <Button
              variant="primary"
              icon={<Send className="size-4" />}
              disabled={published && !hasChanges}
              onClick={() => setShowPublish(true)}
            >
              {published
                ? hasChanges
                  ? `Publish ${detail.changes.total} change${detail.changes.total === 1 ? '' : 's'}`
                  : 'Published'
                : 'Publish'}
            </Button>
            <Menu
              label="More actions"
              trigger={<Ellipsis className="size-4" />}
              items={[
                {
                  label: 'Edit name & dates',
                  icon: <Pencil />,
                  onSelect: () => setShowDetails(true),
                },
                {
                  label: 'Delete schedule',
                  icon: <Trash2 />,
                  danger: true,
                  onSelect: () => setShowDelete(true),
                },
              ]}
            />
          </div>
        </div>
      </div>

      {!published ? (
        <Banner tone="slate">
          <strong>Draft.</strong> Only admins can see this schedule. Build it out, then publish to
          email everyone with a shift so they can confirm.
        </Banner>
      ) : hasChanges ? (
        <Banner tone="amber">
          <strong>
            {detail.changes.total} unpublished change{detail.changes.total === 1 ? '' : 's'}
          </strong>{' '}
          (
          {[
            detail.changes.added && `${detail.changes.added} new`,
            detail.changes.updated && `${detail.changes.updated} edited`,
            detail.changes.removed && `${detail.changes.removed} removed`,
          ]
            .filter(Boolean)
            .join(', ')}
          ). The team still sees the published version until you publish.
        </Banner>
      ) : null}

      {weeks.length > 1 && (
        <Tabs
          className="mb-3 w-fit"
          value={String(weekIndex)}
          onChange={(v) => setWeekIndex(Number(v))}
          options={weeks.map((w, i) => ({
            value: String(i),
            label: `Week ${i + 1} · ${formatDateRange(w[0]!, w[w.length - 1]!)}`,
          }))}
        />
      )}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full min-w-[860px] table-fixed border-collapse text-sm sm:min-w-[980px]">
            <colgroup>
              <col className="w-36 sm:w-52" />
              {days.map((d) => (
                <col key={d} />
              ))}
            </colgroup>
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80">
                <th
                  scope="col"
                  className="sticky left-0 z-10 bg-slate-50 px-4 py-2.5 text-left text-xs font-semibold text-slate-500"
                >
                  {rows.length} {rows.length === 1 ? 'person' : 'people'}
                </th>
                {days.map((d) => {
                  const dayShifts = weekShifts.filter((s) => localDate(s.startTime, tz) === d);
                  return (
                    <th
                      key={d}
                      scope="col"
                      className={cx(
                        'px-1.5 py-2 text-center text-xs font-semibold',
                        d === today ? 'text-indigo-700' : 'text-slate-500',
                      )}
                    >
                      <span className="block">
                        {DateTime.fromISO(d).toFormat('ccc')}{' '}
                        <span
                          className={cx(
                            'inline-flex size-6 items-center justify-center rounded-full',
                            d === today ? 'bg-indigo-600 text-white' : 'text-slate-800',
                          )}
                        >
                          {DateTime.fromISO(d).day}
                        </span>
                      </span>
                      <span className="mt-0.5 block font-normal text-slate-400">
                        {dayShifts.length
                          ? `${dayShifts.length} · ${formatHours(totalHours(dayShifts))}`
                          : '—'}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((person) => {
                const shiftsByDay = byUserDay.get(person.id);
                const personWeek = weekShifts.filter((s) => s.userId === person.id);
                return (
                  <tr key={person.id} className="border-b border-slate-100">
                    <th
                      scope="row"
                      className="sticky left-0 z-10 bg-white px-3 py-2 text-left font-normal sm:px-4"
                    >
                      <div className="flex items-center gap-2.5">
                        <Avatar name={person.name} size="sm" className="hidden sm:inline-flex" />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-slate-900">
                            {person.name}
                          </p>
                          <p className="text-xs text-slate-500">
                            {personWeek.length
                              ? `${formatHours(totalHours(personWeek))} · ${personWeek.length} shift${personWeek.length === 1 ? '' : 's'}`
                              : 'No shifts'}
                            {!person.active && ' · deactivated'}
                            {person.tierId !== schedule.tierId && person.active && ' · other tier'}
                          </p>
                        </div>
                      </div>
                    </th>
                    {days.map((day) => {
                      const key = `${person.id}|${day}`;
                      const shifts = shiftsByDay?.get(day) ?? [];
                      const removed = removedByUserDay.get(person.id)?.get(day) ?? [];
                      const off = offByUserDay.get(person.id)?.get(day);
                      return (
                        <td
                          key={day}
                          {...cellDrop(person.id, day)}
                          className={cx(
                            'group h-20 border-l border-slate-100 p-1 align-top transition-colors',
                            isWeekend(day) && 'bg-slate-50/50',
                            dropKey === key && 'bg-indigo-50 ring-2 ring-inset ring-indigo-400',
                          )}
                        >
                          <div className="flex min-h-[4.5rem] flex-col gap-1">
                            {off && <TimeOffChip entry={off} />}
                            {shifts.map((s) => {
                              const label = s.labelId ? labelsById.get(s.labelId) : undefined;
                              return (
                                <ShiftChip
                                  key={s.id}
                                  shift={s}
                                  tz={tz}
                                  color={label?.color ?? schedule.tierColor}
                                  labelName={label?.name}
                                  status={s.published ? s.status : null}
                                  change={
                                    published && s.changeState !== 'unchanged'
                                      ? (s.changeState as 'new' | 'updated')
                                      : null
                                  }
                                  draggable
                                  dragging={draggingId === s.id}
                                  onDragStart={onDragStart(s)}
                                  onDragEnd={onDragEnd}
                                  onClick={() => setDialog({ mode: 'edit', shift: s })}
                                />
                              );
                            })}
                            {removed.map((s) => (
                              <ShiftChip
                                key={s.id}
                                shift={s}
                                tz={tz}
                                color={schedule.tierColor}
                                status={null}
                                removed
                                onRestore={() => restore.mutate(s.id)}
                              />
                            ))}
                            {person.active && (
                              <button
                                type="button"
                                onClick={() => openCreate(person.id, day)}
                                aria-label={`Add shift for ${person.name} on ${formatDay(day)}`}
                                className="flex h-6 w-full items-center justify-center rounded-md border border-dashed border-slate-300 text-slate-400 opacity-0 transition hover:border-indigo-400 hover:bg-indigo-50 hover:text-indigo-600 focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                              >
                                <Plus className="size-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={days.length + 1}
                    className="px-4 py-10 text-center text-sm text-slate-500"
                  >
                    No one is in {schedule.tierName} yet. Add people on the People page, or add
                    someone below.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
          <div className="flex items-center gap-2">
            <UserPlus className="size-4 text-slate-400" />
            <Select
              aria-label="Add someone from another tier"
              className="h-8 w-64 text-xs"
              value=""
              onChange={(e) => e.target.value && setExtraRows((r) => [...r, e.target.value])}
            >
              <option value="">Add someone from another tier…</option>
              {addableRows.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <p className="text-xs text-slate-500">
            Drag shifts to move them · hold{' '}
            <kbd className="rounded border border-slate-300 bg-slate-50 px-1">Alt</kbd> or{' '}
            <kbd className="rounded border border-slate-300 bg-slate-50 px-1">Ctrl</kbd> to copy ·
            times in {zoneLabel(tz)}
          </p>
        </div>
      </Card>
      <div className="mt-4">
        <ScheduleLegend showChanges={published} />
      </div>

      {dialog?.mode === 'create' && (
        <ShiftDialog
          mode="create"
          initial={dialog.draft}
          tz={tz}
          days={allDays}
          members={rows}
          people={people.data ?? []}
          labels={detail.labels}
          timeOff={detail.timeOff}
          allShifts={detail.shifts}
          saving={create.isPending}
          error={create.error}
          onSave={(payload) => create.mutate(payload)}
          onClose={() => {
            setDialog(null);
            create.reset();
          }}
        />
      )}
      {dialog?.mode === 'edit' && (
        <ShiftDialog
          key={dialog.shift.id}
          mode="edit"
          shift={dialog.shift}
          initial={draftFromShift(dialog.shift, tz)}
          tz={tz}
          days={allDays}
          members={rows}
          people={people.data ?? []}
          labels={detail.labels}
          timeOff={detail.timeOff}
          allShifts={detail.shifts}
          saving={update.isPending}
          deleting={remove.isPending}
          error={update.error}
          onSave={(payload) => update.mutate({ shiftId: dialog.shift.id, payload })}
          onDelete={() => remove.mutate(dialog.shift.id)}
          onDuplicate={(draft) => {
            update.reset();
            const nextDay = addDays(draft.date, 1);
            setDialog({
              mode: 'create',
              draft: { ...draft, date: allDays.includes(nextDay) ? nextDay : draft.date },
            });
          }}
          onClose={() => {
            setDialog(null);
            update.reset();
          }}
        />
      )}
      {showPublish && (
        <ConfirmDialog
          title={published ? 'Publish changes?' : `Publish ${schedule.tierName} schedule?`}
          confirmLabel={published ? 'Publish changes' : 'Publish & email team'}
          loading={publish.isPending}
          onConfirm={() => publish.mutate()}
          onClose={() => setShowPublish(false)}
        >
          {published ? (
            <p>
              Only the {affectedPeople} {affectedPeople === 1 ? 'person' : 'people'} whose shifts
              changed will get an email describing what's new, changed or cancelled. Changed shifts
              need to be confirmed again.
            </p>
          ) : (
            <p>
              {detail.shifts.length} shift{detail.shifts.length === 1 ? '' : 's'} become visible to
              the team, and {affectedPeople} {affectedPeople === 1 ? 'person gets' : 'people get'}{' '}
              an email with their shifts and a <strong>Confirm</strong> button. You can still make
              changes afterwards.
            </p>
          )}
        </ConfirmDialog>
      )}
      {showDiscard && (
        <ConfirmDialog
          title="Discard unpublished changes?"
          confirmLabel="Discard changes"
          danger
          loading={discard.isPending}
          onConfirm={() => discard.mutate()}
          onClose={() => setShowDiscard(false)}
        >
          The schedule goes back to exactly what the team sees now. {detail.changes.total} change
          {detail.changes.total === 1 ? '' : 's'} will be lost.
        </ConfirmDialog>
      )}
      {showDelete && (
        <ConfirmDialog
          title="Delete this schedule?"
          confirmLabel="Delete schedule"
          danger
          loading={destroy.isPending}
          onConfirm={() => destroy.mutate()}
          onClose={() => setShowDelete(false)}
        >
          {published
            ? 'Everyone with an upcoming shift on this schedule will get an email saying their shifts are cancelled. This can’t be undone.'
            : 'This draft and its shifts will be deleted. The team never saw it.'}
        </ConfirmDialog>
      )}
      {showDetails && (
        <ScheduleDetailsDialog
          schedule={schedule}
          onClose={() => setShowDetails(false)}
          onSaved={refresh}
        />
      )}
    </>
  );
}

function Banner({ tone, children }: { tone: 'slate' | 'amber'; children: ReactNode }) {
  return (
    <div
      className={cx(
        'mb-4 rounded-lg px-4 py-2.5 text-sm ring-1 ring-inset',
        tone === 'amber'
          ? 'bg-amber-50 text-amber-900 ring-amber-200'
          : 'bg-slate-100 text-slate-700 ring-slate-200',
      )}
    >
      {children}
    </div>
  );
}

function ScheduleDetailsDialog({
  schedule,
  onClose,
  onSaved,
}: {
  schedule: ScheduleSummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(schedule.name ?? '');
  const [startDate, setStartDate] = useState(schedule.startDate);
  const [endDate, setEndDate] = useState(schedule.endDate);
  const save = useMutation({
    mutationFn: () =>
      api.patch<ScheduleSummary>(`/schedules/${schedule.id}`, {
        name: name || null,
        startDate,
        endDate,
      }),
    onSuccess: () => {
      toast.success('Schedule updated');
      onSaved();
      onClose();
    },
  });
  const errors = fieldErrors(save.error);
  return (
    <Modal
      title="Schedule details"
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
        <FormError message={formMessage(save.error, ['name', 'startDate', 'endDate'])} />
        <Field label="Name" optional hint="Defaults to the date range." error={errors.name}>
          <Input
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder={formatDateRange(startDate, endDate)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First day" error={errors.startDate}>
            <Input
              type="date"
              required
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </Field>
          <Field label="Last day" error={errors.endDate}>
            <Input
              type="date"
              required
              min={startDate}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
