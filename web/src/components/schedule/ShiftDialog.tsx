import {
  addDays,
  dayOfWeek,
  eachDay,
  formatDay,
  formatShiftWhen,
  formatTimeOfDay,
  localTime,
  shiftTimesFromLocal,
  startOfWeek,
  type ISODate,
  type TimeFormat,
} from '@shared/time';
import { timeOffOverlaps } from '@shared/timeOff';
import type { BuilderShift, Label, PersonRow, Tier, TimeOffEntry } from '@shared/types';
import { CalendarClock, Copy, Eye, Repeat, Trash2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { alpha } from '../../lib/colors';
import { cx } from '../../lib/cx';
import { fieldErrors, formMessage } from '../../lib/forms';
import { useHolidays } from '../../lib/holidays';
import { useBootstrapData, useTimeFormat } from '../../lib/session';
import { Button } from '../ui/Button';
import { Field, FormError, Select, Textarea } from '../ui/Form';
import { Badge } from '../ui/Misc';
import { Modal } from '../ui/Modal';
import { DateInput, TimeInput } from '../ui/Pickers';

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

/** The same shift on several days (see "Repeats"). */
export interface RepeatPayload {
  userId: string;
  labelId: string | null;
  notes: string | null;
  shifts: { startTime: string; endTime: string }[];
}

/** Which weekdays a new shift repeats on (0 = Sunday), and until when. */
interface RepeatRule {
  days: number[];
  until: ISODate;
  skipHolidays: boolean;
}

type RepeatKind = 'none' | 'weekdays' | 'daily' | 'weekly' | 'custom';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
/** Longest a repeat can run (about half a year). */
const MAX_REPEAT_DAYS = 26 * 7;

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

function presetLabel(start: string, end: string, format: TimeFormat): string {
  const overnight = end <= start ? ' (+1)' : '';
  return `${formatTimeOfDay(start, format, true)}–${formatTimeOfDay(end, format, true)}${overnight}`;
}

const sameDays = (a: number[], b: number[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

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
  onSaveMany,
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
  /** When adding: save a repeating shift as one shift per day. */
  onSaveMany?: (payload: RepeatPayload) => void;
  onDelete?: () => void;
  onDuplicate?: (draft: ShiftDraft) => void;
  onClose: () => void;
}) {
  const { org } = useBootstrapData();
  const timeFormat = useTimeFormat();
  const [draft, setDraft] = useState<ShiftDraft>(initial);
  const [repeat, setRepeat] = useState<RepeatRule | null>(null);
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
  const draftTimes = shiftTimesFromLocal(draft.date, draft.start, draft.end, tz);
  const offThatDay = timeOff.find(
    (t) =>
      t.userId === draft.userId && timeOffOverlaps(t, draftTimes.startTime, draftTimes.endTime, tz),
  );
  const personName = (id: string) => byId.get(id)?.name ?? 'Someone';
  const errors = fieldErrors(error);
  const published = shift?.published;
  const set = (patch: Partial<ShiftDraft>) => setDraft((d) => ({ ...d, ...patch }));

  // ---- repeating ------------------------------------------------------------
  const endOfWeek = addDays(startOfWeek(draft.date, org.weekStartsOn), 6);
  const until = repeat ? (repeat.until < draft.date ? draft.date : repeat.until) : draft.date;
  const holidays = useHolidays(draft.date, until);
  const repeatDays = repeat
    ? eachDay(draft.date, until).filter((d) => repeat.days.includes(dayOfWeek(d)))
    : [];
  const holidayDays = repeatDays.filter((d) => holidays.has(d));
  const occurrences = repeat
    ? repeatDays.filter((d) => !(repeat.skipHolidays && holidays.has(d)))
    : [draft.date];
  const repeatKind: RepeatKind = !repeat
    ? 'none'
    : sameDays(repeat.days, WEEKDAYS)
      ? 'weekdays'
      : sameDays(repeat.days, EVERY_DAY)
        ? 'daily'
        : sameDays(repeat.days, [dayOfWeek(draft.date)])
          ? 'weekly'
          : 'custom';
  const chooseRepeat = (kind: RepeatKind) => {
    if (kind === 'none') return setRepeat(null);
    const skipHolidays = repeat?.skipHolidays ?? false;
    const days =
      kind === 'weekdays'
        ? WEEKDAYS
        : kind === 'daily'
          ? EVERY_DAY
          : kind === 'weekly'
            ? [dayOfWeek(draft.date)]
            : (repeat?.days ?? [dayOfWeek(draft.date)]);
    let next =
      kind === 'weekly' ? addDays(draft.date, 27) : kind === 'custom' && repeat ? until : endOfWeek;
    // Starting on a Saturday with "every weekday"? Run into next week.
    if (!eachDay(draft.date, next).some((d) => days.includes(dayOfWeek(d))))
      next = addDays(next, 7);
    setRepeat({ days, until: next, skipHolidays });
  };
  const repeating = mode === 'create' && repeat !== null;

  const submit = () => {
    const base = {
      userId: draft.userId,
      labelId: draft.labelId,
      notes: draft.notes.trim() || null,
    };
    if (repeating && onSaveMany) {
      onSaveMany({
        ...base,
        shifts: occurrences.map((d) => shiftTimesFromLocal(d, draft.start, draft.end, tz)),
      });
    } else {
      onSave({ ...base, ...shiftTimesFromLocal(draft.date, draft.start, draft.end, tz) });
    }
  };

  return (
    <Modal
      title={mode === 'create' ? 'Add shift' : 'Edit shift'}
      description={
        mode === 'edit' && shift
          ? `${personName(shift.userId)} · ${formatShiftWhen(shift.startTime, shift.endTime, tz, timeFormat)}`
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
          <Button
            type="submit"
            variant="primary"
            loading={saving}
            disabled={repeating && occurrences.length === 0}
          >
            {mode === 'edit'
              ? 'Save changes'
              : repeating
                ? `Add ${occurrences.length} shift${occurrences.length === 1 ? '' : 's'}`
                : 'Add shift'}
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
                {formatShiftWhen(published.startTime, published.endTime, tz, timeFormat)}
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
          <Field label={repeating ? 'Starting' : 'Day'} error={errors.startTime}>
            <DateInput value={draft.date} onChange={(date) => set({ date })} />
          </Field>
        </div>

        <div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Starts">
              <TimeInput
                value={draft.start}
                format={timeFormat}
                onChange={(start) => set({ start })}
              />
            </Field>
            <Field
              label="Ends"
              error={errors.endTime}
              hint={overnight ? 'Ends the next day' : undefined}
            >
              <TimeInput
                value={draft.end}
                format={timeFormat}
                after={draft.start}
                onChange={(end) => set({ end })}
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
                  'rounded-full px-2.5 py-1 text-xs font-medium tabular-nums',
                  draft.start === start && draft.end === end
                    ? 'neon bg-neon text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200',
                )}
              >
                {presetLabel(start, end, timeFormat)}
              </button>
            ))}
          </div>
        </div>

        {mode === 'create' && onSaveMany && (
          <RepeatSection
            kind={repeatKind}
            rule={repeat}
            date={draft.date}
            until={until}
            endOfWeek={endOfWeek}
            weekStartsOn={org.weekStartsOn}
            occurrences={occurrences}
            holidayDays={holidayDays}
            holidayNames={(d) =>
              holidays
                .get(d)
                ?.map((h) => h.name)
                .join(', ') ?? ''
            }
            personName={personName(draft.userId)}
            onKind={chooseRepeat}
            onChange={(patch) => setRepeat((r) => (r ? { ...r, ...patch } : r))}
          />
        )}

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

        {offThatDay && !repeating && (
          <div className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-900 ring-1 ring-inset ring-amber-200">
            <CalendarClock className="mt-0.5 size-4 shrink-0" />
            <p>
              {personName(draft.userId)} has{' '}
              {offThatDay.status === 'approved' ? 'approved' : 'requested'}{' '}
              <strong>{offThatDay.typeName ?? 'time off'}</strong> on{' '}
              {offThatDay.startTime && offThatDay.endTime
                ? formatShiftWhen(offThatDay.startTime, offThatDay.endTime, tz, timeFormat)
                : formatDay(draft.date)}
              .
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

/** "Repeats": which weekdays, until when, and whether to skip holidays. */
function RepeatSection({
  kind,
  rule,
  date,
  until,
  endOfWeek,
  weekStartsOn,
  occurrences,
  holidayDays,
  holidayNames,
  personName,
  onKind,
  onChange,
}: {
  kind: RepeatKind;
  rule: RepeatRule | null;
  date: ISODate;
  until: ISODate;
  endOfWeek: ISODate;
  weekStartsOn: 0 | 1;
  occurrences: ISODate[];
  holidayDays: ISODate[];
  holidayNames: (day: ISODate) => string;
  personName: string;
  onKind: (kind: RepeatKind) => void;
  onChange: (patch: Partial<RepeatRule>) => void;
}) {
  const weekday = DAY_NAMES[dayOfWeek(date)]!;
  const order = [0, 1, 2, 3, 4, 5, 6].map((i) => (i + weekStartsOn) % 7);
  const shortcuts: [string, ISODate][] = [
    ['This week', endOfWeek],
    ['2 weeks', addDays(endOfWeek, 7)],
    ['4 weeks', addDays(endOfWeek, 21)],
    ['8 weeks', addDays(endOfWeek, 49)],
  ];
  const maxUntil = addDays(date, MAX_REPEAT_DAYS - 1);
  return (
    <div className="rounded-xl bg-slate-50/80 p-3 ring-1 ring-inset ring-slate-200/70">
      <Field label="Repeats">
        <Select value={kind} onChange={(e) => onKind(e.target.value as RepeatKind)}>
          <option value="none">Doesn’t repeat</option>
          <option value="weekdays">Every weekday (Monday to Friday)</option>
          <option value="daily">Every day</option>
          <option value="weekly">Weekly on {weekday}</option>
          <option value="custom">Custom days…</option>
        </Select>
      </Field>
      {rule && (
        <div className="mt-3 space-y-3">
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-slate-700">On</legend>
            <div className="flex gap-1.5" role="group">
              {order.map((dow) => {
                const on = rule.days.includes(dow);
                const name = DAY_NAMES[dow]!;
                return (
                  <button
                    key={dow}
                    type="button"
                    aria-pressed={on}
                    aria-label={name}
                    title={name}
                    onClick={() =>
                      onChange({
                        days: on ? rule.days.filter((d) => d !== dow) : [...rule.days, dow],
                      })
                    }
                    className={cx(
                      'flex size-9 items-center justify-center rounded-full text-xs font-semibold transition',
                      on
                        ? 'neon bg-neon text-white'
                        : 'bg-surface text-slate-600 ring-1 ring-inset ring-slate-300 hover:text-slate-900',
                    )}
                  >
                    {name.slice(0, 2)}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <div className="space-y-2">
            <Field label="Until">
              <DateInput
                value={until}
                min={date}
                max={maxUntil}
                onChange={(day) => onChange({ until: day })}
              />
            </Field>
            <div className="flex flex-wrap gap-1.5">
              {shortcuts.map(([label, day]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => onChange({ until: day > maxUntil ? maxUntil : day })}
                  className={cx(
                    'rounded-full px-2.5 py-1 text-xs font-medium',
                    until === day
                      ? 'bg-brand-600 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {holidayDays.length > 0 && (
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={rule.skipHolidays}
                onChange={(e) => onChange({ skipHolidays: e.target.checked })}
                className="mt-0.5 size-4 accent-brand-600"
              />
              <span>
                Skip statutory holidays
                <span className="block text-xs text-slate-500">
                  {holidayDays.map((d) => `${holidayNames(d)} (${formatDay(d)})`).join(', ')}
                </span>
              </span>
            </label>
          )}
          <p className="flex gap-2 text-sm text-slate-600">
            <Repeat className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden />
            <span>
              {occurrences.length === 0 ? (
                'No days picked in this range.'
              ) : (
                <>
                  <strong className="text-slate-900">
                    {occurrences.length} shift{occurrences.length === 1 ? '' : 's'}
                  </strong>
                  , {formatDay(occurrences[0]!)}
                  {occurrences.length > 1 && ` – ${formatDay(occurrences.at(-1)!)}`}. Each is its
                  own shift, so you can still change any single day. Days {personName} already works
                  or has approved time off are skipped.
                </>
              )}
            </span>
          </p>
        </div>
      )}
    </div>
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
