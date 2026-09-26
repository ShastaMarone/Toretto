import {
  formatDay,
  formatShiftWhen,
  formatTimeRange,
  localTime,
  shiftTimesFromLocal,
  type ISODate,
} from '@shared/time';
import type { BuilderShift, Label, PersonRow, Tier, TimeOffEntry } from '@shared/types';
import { CalendarClock, Copy, Eye, Trash2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { alpha } from '../../lib/colors';
import { cx } from '../../lib/cx';
import { fieldErrors, formMessage } from '../../lib/forms';
import { Button } from '../ui/Button';
import { Field, FormError, Input, Select, Textarea } from '../ui/Form';
import { Modal } from '../ui/Modal';
import { Badge } from '../ui/Misc';

export interface ShiftDraft {
  userId: string;
  date: ISODate;
  start: string;
  end: string;
  labelId: string | null;
  notes: string;
}

export interface ShiftPayload {
  userId: string;
  labelId: string | null;
  startTime: string;
  endTime: string;
  notes: string | null;
}

const DEFAULT_PRESETS: [string, string][] = [
  ['09:00', '17:00'],
  ['08:00', '16:00'],
  ['12:00', '20:00'],
];

/** Distinct start/end times already used in this schedule, most common first. */
function presetsFrom(shifts: BuilderShift[], tz: string): [string, string][] {
  const counts = new Map<string, number>();
  for (const s of shifts) {
    const key = `${localTime(s.startTime, tz)}-${localTime(s.endTime, tz)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const used = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k.split('-') as [string, string]);
  const all = [...used, ...DEFAULT_PRESETS];
  const seen = new Set<string>();
  return all
    .filter(([a, b]) => (seen.has(`${a}-${b}`) ? false : (seen.add(`${a}-${b}`), true)))
    .slice(0, 5);
}

function presetLabel(start: string, end: string, tz: string): string {
  const { startTime, endTime } = shiftTimesFromLocal('2026-01-05', start, end, tz);
  return formatTimeRange(startTime, endTime, tz, { short: true });
}

export function ShiftDialog({
  mode,
  initial,
  shift,
  tz,
  people,
  tiers,
  labels,
  timeOff,
  allShifts,
  saving,
  deleting,
  error,
  onSave,
  onDelete,
  onDuplicate,
  onClose,
}: {
  mode: 'create' | 'edit';
  initial: ShiftDraft;
  shift?: BuilderShift;
  tz: string;
  /** Everyone who can be scheduled, grouped by tier in the picker. */
  people: PersonRow[];
  tiers: Pick<Tier, 'id' | 'name'>[];
  labels: Label[];
  timeOff: TimeOffEntry[];
  allShifts: BuilderShift[];
  saving: boolean;
  deleting?: boolean;
  error: unknown;
  onSave: (payload: ShiftPayload) => void;
  onDelete?: () => void;
  onDuplicate?: (draft: ShiftDraft) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ShiftDraft>(initial);
  const presets = useMemo(() => presetsFrom(allShifts, tz), [allShifts, tz]);
  const byId = new Map(people.map((p) => [p.id, p]));
  const person = byId.get(draft.userId);
  // Tier labels are only for people in that tier (a shift keeps the label it has).
  const usable = labels.filter(
    (l) => l.tierId === null || l.tierId === person?.tierId || l.id === draft.labelId,
  );
  const tierName = new Map(tiers.map((t) => [t.id, t.name]));
  const groups = [
    ...tiers.map((t) => ({ label: t.name, people: people.filter((p) => p.tierId === t.id) })),
    { label: 'No tier', people: people.filter((p) => !p.tierId || !tierName.has(p.tierId)) },
  ].filter((g) => g.people.length);
  const overnight = draft.end <= draft.start;
  const offThatDay = timeOff.find(
    (t) => t.userId === draft.userId && t.startDate <= draft.date && t.endDate >= draft.date,
  );
  const personName = (id: string) => byId.get(id)?.name ?? 'Someone';
  const errors = fieldErrors(error);
  const published = shift?.published;
  const set = (patch: Partial<ShiftDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const submit = () => {
    const times = shiftTimesFromLocal(draft.date, draft.start, draft.end, tz);
    onSave({
      userId: draft.userId,
      labelId: draft.labelId,
      notes: draft.notes.trim() || null,
      ...times,
    });
  };

  return (
    <Modal
      title={mode === 'create' ? 'Add shift' : 'Edit shift'}
      description={
        mode === 'edit' && shift
          ? `${personName(shift.userId)} · ${formatShiftWhen(shift.startTime, shift.endTime, tz)}`
          : undefined
      }
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          {mode === 'edit' && onDelete && (
            <Button
              variant="danger-ghost"
              icon={<Trash2 className="size-4" />}
              onClick={onDelete}
              loading={deleting}
              className="mr-auto"
            >
              Delete
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          {mode === 'edit' && onDuplicate && (
            <Button icon={<Copy className="size-4" />} onClick={() => onDuplicate(draft)}>
              Duplicate
            </Button>
          )}
          <Button type="submit" variant="primary" loading={saving}>
            {mode === 'create' ? 'Add shift' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={formMessage(error, ['userId', 'startTime', 'endTime', 'labelId'])} />

        {shift && shift.published && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {shift.status === 'confirmed' ? (
              <Badge tone="green">Confirmed</Badge>
            ) : (
              <Badge tone="amber">Waiting for confirmation</Badge>
            )}
            {shift.changeState === 'updated' && published && (
              <span className="flex items-center gap-1">
                <Eye className="size-3.5" /> Team currently sees {personName(published.userId)},{' '}
                {formatShiftWhen(published.startTime, published.endTime, tz)}
              </span>
            )}
            {shift.status === 'confirmed' && (
              <span>Changing the time, person or label asks them to confirm again.</span>
            )}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Person" error={errors.userId}>
            <Select
              value={draft.userId}
              required
              onChange={(e) => {
                const next = byId.get(e.target.value);
                const label = labels.find((l) => l.id === draft.labelId);
                // Drop a tier label that doesn't apply to the new person.
                const keep = !label?.tierId || label.tierId === next?.tierId;
                set({ userId: e.target.value, labelId: keep ? draft.labelId : null });
              }}
            >
              {groups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.people
                    .filter((p) => p.active || p.id === draft.userId)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          <Field label="Day" error={errors.startTime} hint={formatDay(draft.date)}>
            <Input
              type="date"
              required
              value={draft.date}
              onChange={(e) => e.target.value && set({ date: e.target.value })}
            />
          </Field>
        </div>

        <div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Starts">
              <Input
                type="time"
                required
                value={draft.start}
                step={300}
                onChange={(e) => set({ start: e.target.value })}
              />
            </Field>
            <Field
              label="Ends"
              error={errors.endTime}
              hint={overnight ? 'Ends the next day' : undefined}
            >
              <Input
                type="time"
                required
                value={draft.end}
                step={300}
                onChange={(e) => set({ end: e.target.value })}
              />
            </Field>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {presets.map(([start, end]) => (
              <button
                key={`${start}-${end}`}
                type="button"
                onClick={() => set({ start, end })}
                className={cx(
                  'rounded-full px-2.5 py-1 text-xs font-medium',
                  draft.start === start && draft.end === end
                    ? 'neon bg-neon text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200',
                )}
              >
                {presetLabel(start, end, tz)}
              </button>
            ))}
          </div>
        </div>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-slate-700">Label</legend>
          <div className="flex flex-wrap gap-1.5">
            <LabelOption
              selected={draft.labelId === null}
              color="#94a3b8"
              onClick={() => set({ labelId: null })}
            >
              No label
            </LabelOption>
            {usable.map((l) => (
              <LabelOption
                key={l.id}
                selected={draft.labelId === l.id}
                color={l.color}
                onClick={() => set({ labelId: l.id })}
              >
                {l.name}
                {l.tierId !== null && (
                  <span className="text-[10px] opacity-60"> · {tierName.get(l.tierId)}</span>
                )}
              </LabelOption>
            ))}
          </div>
          {errors.labelId && <p className="mt-1.5 text-xs text-rose-600">{errors.labelId}</p>}
        </fieldset>

        {offThatDay && (
          <div className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-900 ring-1 ring-inset ring-amber-200">
            <CalendarClock className="mt-0.5 size-4 shrink-0" />
            <p>
              {personName(draft.userId)} has{' '}
              {offThatDay.status === 'approved' ? 'approved' : 'requested'}{' '}
              <strong>{offThatDay.typeName ?? 'time off'}</strong> on {formatDay(draft.date)}.
            </p>
          </div>
        )}

        <Field label="Note" optional hint="Shown to the person in their schedule and email.">
          <Textarea
            rows={2}
            maxLength={500}
            value={draft.notes}
            onChange={(e) => set({ notes: e.target.value })}
            placeholder="e.g. Covering the chat queue"
          />
        </Field>
      </div>
    </Modal>
  );
}

function LabelOption({
  selected,
  color,
  onClick,
  children,
}: {
  selected: boolean;
  color: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cx(
        'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition',
        selected ? 'text-slate-900' : 'border-slate-200 text-slate-600 hover:border-slate-300',
      )}
      style={selected ? { backgroundColor: alpha(color, 0.12), borderColor: color } : undefined}
    >
      <span className="size-2 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      {children}
    </button>
  );
}
