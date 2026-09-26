import {
  addDays,
  diffDays,
  formatDay,
  formatTimeRange,
  localDate,
  type ISODate,
} from '@shared/time';
import type { TimeOffRequest } from '@shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import { toast } from 'sonner';
import { api } from '../api/client';
import { keys, useMyShifts, useTimeOffTypes } from '../api/queries';
import { alpha } from '../lib/colors';
import { cx } from '../lib/cx';
import { fieldErrors, formMessage } from '../lib/forms';
import { useTimeFormat, useViewerZone } from '../lib/session';
import { Button } from './ui/Button';
import { Field, FormError, Textarea } from './ui/Form';
import { DateInput } from './ui/Pickers';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Misc';

/** A team member asks for one or more days off (paid holiday, personal day, ...). */
export function TimeOffRequestDialog({
  initialDate,
  onClose,
}: {
  initialDate: ISODate;
  onClose: () => void;
}) {
  const tz = useViewerZone();
  const timeFormat = useTimeFormat();
  const queryClient = useQueryClient();
  const types = useTimeOffTypes();
  const [typeId, setTypeId] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(initialDate);
  const [endDate, setEndDate] = useState(initialDate);
  const [note, setNote] = useState('');
  const selectedType = typeId ?? types.data?.[0]?.id ?? '';
  const validRange = endDate >= startDate;
  const shifts = useMyShifts(startDate, validRange ? endDate : startDate);

  const submit = useMutation({
    mutationFn: () =>
      api.post<TimeOffRequest>('/my/time-off', {
        typeId: selectedType,
        startDate,
        endDate,
        note: note || null,
      }),
    onSuccess: (request) => {
      void queryClient.invalidateQueries({ queryKey: keys.myTimeOff });
      toast.success(`${request.type.name} requested — your admin will review it.`);
      onClose();
    },
  });
  const errors = fieldErrors(submit.error);
  const days = validRange ? diffDays(startDate, endDate) + 1 : 0;

  return (
    <Modal
      title="Request time off"
      description="Your admin is notified and you'll get an email when it's reviewed."
      onClose={onClose}
      onSubmit={() => submit.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            loading={submit.isPending}
            disabled={!selectedType || !validRange}
          >
            Request {days > 0 ? `${days} day${days === 1 ? '' : 's'}` : 'time off'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <FormError message={formMessage(submit.error, ['startDate', 'endDate', 'typeId'])} />
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-slate-700">Type of time off</legend>
          {types.isLoading ? (
            <Spinner />
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {types.data?.map((type) => {
                const selected = type.id === selectedType;
                return (
                  <label
                    key={type.id}
                    className={cx(
                      'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition',
                      selected
                        ? 'border-transparent ring-2'
                        : 'border-slate-200 hover:border-slate-300',
                    )}
                    style={
                      selected
                        ? ({
                            backgroundColor: alpha(type.color, 0.08),
                            '--tw-ring-color': type.color,
                          } as CSSProperties)
                        : undefined
                    }
                  >
                    <input
                      type="radio"
                      name="type"
                      value={type.id}
                      checked={selected}
                      onChange={() => setTypeId(type.id)}
                      className="sr-only"
                    />
                    <span
                      className="size-3 shrink-0 rounded-full"
                      style={{ backgroundColor: type.color }}
                      aria-hidden
                    />
                    <span className="flex-1 font-medium text-slate-800">{type.name}</span>
                    <span className="text-xs text-slate-500">{type.paid ? 'Paid' : 'Unpaid'}</span>
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First day" error={errors.startDate}>
            <DateInput
              value={startDate}
              onChange={(value) => {
                setStartDate(value);
                if (endDate < value) setEndDate(value);
              }}
            />
          </Field>
          <Field
            label="Last day"
            error={errors.endDate ?? (!validRange ? 'Must be on or after the first day' : null)}
          >
            <DateInput min={startDate} value={endDate} onChange={setEndDate} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            ['Just this day', 0],
            ['2 days', 1],
            ['A week', 6],
          ].map(([label, extra]) => (
            <button
              key={label}
              type="button"
              onClick={() => setEndDate(addDays(startDate, extra as number))}
              className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200"
            >
              {label}
            </button>
          ))}
        </div>
        {shifts.data && shifts.data.length > 0 && (
          <div className="rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-900 ring-1 ring-inset ring-amber-200">
            <p className="flex items-center gap-1.5 font-medium">
              <CalendarClock className="size-4" /> You're scheduled during this time
            </p>
            <ul className="mt-1 space-y-0.5 text-amber-800">
              {shifts.data.map((s) => (
                <li key={s.id}>
                  {formatDay(localDate(s.startTime, tz))} ·{' '}
                  {formatTimeRange(s.startTime, s.endTime, tz, { format: timeFormat })}
                  {s.label && ` (${s.label.name})`}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-amber-700">
              Your admin will see this when reviewing your request.
            </p>
          </div>
        )}
        <Field label="Note for your admin" optional>
          <Textarea
            rows={2}
            maxLength={500}
            placeholder="e.g. Family trip, appointment…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
