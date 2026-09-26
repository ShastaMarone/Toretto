import { addDays } from '@shared/time';
import { useTimeFormat } from '../lib/session';
import type { TimeOffWhen } from '../lib/timeOffWhen';
import { Field } from './ui/Form';
import { Tabs } from './ui/Misc';
import { DateInput, TimeInput } from './ui/Pickers';

/** Whole days (first and last), or part of one day (from and to). */
export function TimeOffWhenFields({
  value,
  onChange,
  errors,
  quickPicks = false,
}: {
  value: TimeOffWhen;
  onChange: (value: TimeOffWhen) => void;
  errors: Record<string, string | undefined>;
  /** "Just this day", "2 days", "A week" shortcuts for whole days. */
  quickPicks?: boolean;
}) {
  const timeFormat = useTimeFormat();
  const set = (patch: Partial<TimeOffWhen>) => onChange({ ...value, ...patch });
  const backwards = !value.partial && value.endDate < value.startDate;
  return (
    <div className="space-y-3">
      <Tabs
        className="w-fit"
        value={value.partial ? 'partial' : 'days'}
        onChange={(mode) => set({ partial: mode === 'partial', endDate: value.startDate })}
        options={[
          { value: 'days', label: 'Whole days' },
          { value: 'partial', label: 'Part of a day' },
        ]}
      />
      {value.partial ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Day" error={errors.startDate}>
            <DateInput
              value={value.startDate}
              onChange={(day) => set({ startDate: day, endDate: day })}
            />
          </Field>
          <Field label="From" error={errors.startTime}>
            <TimeInput
              value={value.start}
              format={timeFormat}
              onChange={(start) => set({ start })}
            />
          </Field>
          <Field label="To" error={errors.endTime}>
            <TimeInput
              value={value.end}
              format={timeFormat}
              after={value.start}
              onChange={(end) => set({ end })}
            />
          </Field>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="First day" error={errors.startDate}>
              <DateInput
                value={value.startDate}
                onChange={(day) =>
                  set({ startDate: day, endDate: value.endDate < day ? day : value.endDate })
                }
              />
            </Field>
            <Field
              label="Last day"
              error={
                errors.endDate ?? (backwards ? 'Must be on or after the first day' : undefined)
              }
            >
              <DateInput
                min={value.startDate}
                value={value.endDate}
                onChange={(endDate) => set({ endDate })}
              />
            </Field>
          </div>
          {quickPicks && (
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ['Just this day', 0],
                  ['2 days', 1],
                  ['A week', 6],
                ] as const
              ).map(([label, extra]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => set({ endDate: addDays(value.startDate, extra) })}
                  className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200"
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
