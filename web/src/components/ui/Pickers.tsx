import {
  addDays,
  addMonths,
  eachDay,
  formatDay,
  formatHours,
  formatTimeOfDay,
  parseTimeOfDay,
  startOfMonth,
  startOfWeek,
  todayIn,
  type ISODate,
  type TimeFormat,
} from '@shared/time';
import { CalendarDays, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { DateTime } from 'luxon';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { cx } from '../../lib/cx';
import { useHolidays } from '../../lib/holidays';
import { useBootstrapData, useViewerZone } from '../../lib/session';
import { controlClass, useField } from './field';
import { Popover } from './Popover';

// ---------------------------------------------------------------------------
// Time of day
// ---------------------------------------------------------------------------

interface TimeOption {
  value: string;
  /** Minutes past midnight, or past the start time for an end time. */
  minutes: number;
  /** For end times: how long the shift would be. */
  duration?: string;
}

const toMinutes = (time: string) => {
  const [h = 0, m = 0] = time.split(':').map(Number);
  return h * 60 + m;
};
const fromMinutes = (minutes: number) => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** The day in `step`-minute steps; or, after a start time, the next 24 hours. */
function timeOptions(step: number, after?: string): TimeOption[] {
  const count = Math.floor(1440 / step);
  if (after === undefined) {
    return Array.from({ length: count }, (_, i) => ({
      value: fromMinutes(i * step),
      minutes: i * step,
    }));
  }
  const start = toMinutes(after);
  return Array.from({ length: count }, (_, i) => {
    const length = (i + 1) * step;
    return {
      value: fromMinutes(start + length),
      minutes: length,
      duration: formatHours(length / 60),
    };
  });
}

/**
 * A time field with a themed list of times (every 15 minutes by default).
 * People can also type a time: "9", "3pm", "15:30", "930p". With `after`
 * (for an end time), the list starts after that time and shows how long the
 * shift would be. The value is always 'HH:mm'.
 */
export function TimeInput({
  value,
  onChange,
  format,
  step = 15,
  after,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  format: TimeFormat;
  step?: number;
  after?: string;
  id?: string;
}) {
  const { invalid, ...field } = useField(id);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const options = useMemo(() => timeOptions(step, after), [step, after]);
  const [open, setOpen] = useState(false);
  // What's been typed (null = nothing yet), and the highlighted option.
  const [text, setText] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [navigated, setNavigated] = useState(false);

  const indexOf = (time: string) => {
    const minutes =
      after === undefined
        ? toMinutes(time)
        : (toMinutes(time) - toMinutes(after) + 1440) % 1440 || 1440;
    const i = Math.round(minutes / step) - (after === undefined ? 0 : 1);
    return Math.min(options.length - 1, Math.max(0, i));
  };

  const show = () => {
    if (open) return;
    setActive(indexOf(value));
    setNavigated(false);
    setOpen(true);
  };
  const finish = (next: string | null) => {
    if (next && next !== value) onChange(next);
    setText(null);
    setNavigated(false);
    setOpen(false);
  };
  // Keep what was typed (if it's a time) or picked with the arrow keys.
  const commit = () => {
    if (text !== null) finish(parseTimeOfDay(text, { after }));
    else finish(navigated ? (options[active]?.value ?? null) : null);
  };

  // Keep the highlighted time in view.
  useLayoutEffect(() => {
    if (!open) return;
    const box = list.current;
    const option = box?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!option || !box) return;
    if (
      option.offsetTop < box.scrollTop ||
      option.offsetTop + option.offsetHeight > box.scrollTop + box.clientHeight
    ) {
      box.scrollTop = option.offsetTop - box.clientHeight / 2 + option.offsetHeight / 2;
    }
  }, [open, active]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return show();
      const n = options.length;
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
      setText(null);
      setNavigated(true);
    } else if (e.key === 'Enter' && open) {
      e.preventDefault(); // pick the time; don't submit the form
      commit();
    } else if (e.key === 'Tab' && open) {
      commit();
    }
  };

  const shown =
    text ??
    (navigated && options[active]
      ? formatTimeOfDay(options[active].value, format)
      : formatTimeOfDay(value, format));

  return (
    <div className="relative">
      <input
        ref={input}
        type="text"
        role="combobox"
        autoComplete="off"
        spellCheck={false}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        {...field}
        value={shown}
        onFocus={(e) => {
          e.currentTarget.select();
          show();
        }}
        onClick={show}
        onChange={(e) => {
          setText(e.target.value);
          setNavigated(false);
          if (!open) setOpen(true);
          const parsed = parseTimeOfDay(e.target.value, { after });
          if (parsed) setActive(indexOf(parsed));
        }}
        onKeyDown={onKeyDown}
        onBlur={commit}
        className={cx(controlClass, 'h-10 pr-9 pl-3 tabular-nums', invalid && 'ring-rose-400')}
      />
      <Clock
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-slate-400"
        aria-hidden
      />
      {open && (
        <Popover
          anchor={input}
          matchWidth
          onClose={(reason) => (reason === 'escape' ? finish(null) : commit())}
        >
          <div
            ref={list}
            role="listbox"
            id={listId}
            aria-label="Times"
            className="relative max-h-64 overflow-y-auto overscroll-contain py-1 scrollbar-thin"
            // Keep focus in the text box while picking.
            onPointerDown={(e) => e.preventDefault()}
          >
            {options.map((o, i) => (
              <div
                key={o.minutes}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === active}
                onPointerEnter={() => setActive(i)}
                onClick={() => finish(o.value)}
                className={cx(
                  'flex cursor-pointer items-center justify-between gap-3 px-3 py-1.5 text-sm tabular-nums',
                  i === active ? 'bg-brand-50 text-brand-800' : 'text-slate-700',
                  o.value === value && 'font-semibold',
                )}
              >
                <span>{formatTimeOfDay(o.value, format)}</span>
                {o.duration && <span className="text-xs text-slate-400">{o.duration}</span>}
              </div>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const clampDay = (day: ISODate, min?: ISODate, max?: ISODate) =>
  min && day < min ? min : max && day > max ? max : day;

/**
 * A month calendar: arrow keys move by day and week, Page Up/Down by month,
 * Home/End to the ends of the week, Enter picks. Statutory holidays are
 * marked, and weeks start on the organization's chosen day.
 */
export function Calendar({
  value,
  onPick,
  min,
  max,
}: {
  value: ISODate;
  onPick: (day: ISODate) => void;
  min?: ISODate;
  max?: ISODate;
}) {
  const { org } = useBootstrapData();
  const today = todayIn(useViewerZone());
  const [focused, setFocused] = useState(() => clampDay(value, min, max));
  // Move keyboard focus with the arrow keys (and on opening), not on month clicks.
  const takeFocus = useRef(true);
  const grid = useRef<HTMLTableElement>(null);
  const month = startOfMonth(focused);
  const first = startOfWeek(month, org.weekStartsOn);
  const days = eachDay(first, addDays(first, 41));
  const holidays = useHolidays(days[0]!, days[days.length - 1]!);

  useEffect(() => {
    if (!takeFocus.current) return;
    takeFocus.current = false;
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focused}"]`)?.focus();
  }, [focused]);

  const moveTo = (day: ISODate) => {
    takeFocus.current = true;
    setFocused(clampDay(day, min, max));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    const week = startOfWeek(focused, org.weekStartsOn);
    const target: Record<string, ISODate> = {
      ArrowLeft: addDays(focused, -1),
      ArrowRight: addDays(focused, 1),
      ArrowUp: addDays(focused, -7),
      ArrowDown: addDays(focused, 7),
      PageUp: addMonths(focused, e.shiftKey ? -12 : -1),
      PageDown: addMonths(focused, e.shiftKey ? 12 : 1),
      Home: week,
      End: addDays(week, 6),
    };
    const day = target[e.key];
    if (!day) return;
    e.preventDefault();
    moveTo(day);
  };
  const monthButton =
    'rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30';
  const todayAllowed = clampDay(today, min, max) === today;

  return (
    <div className="w-[18.5rem] p-3">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          disabled={!!min && addDays(month, -1) < min}
          onClick={() => setFocused(clampDay(addMonths(focused, -1), min, max))}
          className={monthButton}
        >
          <ChevronLeft className="size-4" />
        </button>
        <p className="text-sm font-semibold text-slate-900" aria-live="polite">
          {DateTime.fromISO(month).toFormat('LLLL yyyy')}
        </p>
        <button
          type="button"
          aria-label="Next month"
          disabled={!!max && addMonths(month, 1) > max}
          onClick={() => setFocused(clampDay(addMonths(focused, 1), min, max))}
          className={monthButton}
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
      <table ref={grid} role="grid" onKeyDown={onKeyDown} className="w-full border-collapse">
        <thead>
          <tr>
            {days.slice(0, 7).map((d) => (
              <th
                key={d}
                scope="col"
                abbr={DateTime.fromISO(d).toFormat('cccc')}
                className="pb-1 text-[11px] font-semibold text-slate-400 uppercase"
              >
                {DateTime.fromISO(d).toFormat('ccccc')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[0, 1, 2, 3, 4, 5].map((w) => (
            <tr key={w}>
              {days.slice(w * 7, w * 7 + 7).map((d) => {
                const inMonth = d.slice(0, 7) === month.slice(0, 7);
                const names = holidays
                  .get(d)
                  ?.map((h) => h.name)
                  .join(', ');
                const disabled = (!!min && d < min) || (!!max && d > max);
                const selected = d === value;
                return (
                  <td key={d} className="p-0.5 text-center">
                    <button
                      type="button"
                      data-day={d}
                      tabIndex={d === focused ? 0 : -1}
                      disabled={disabled}
                      aria-label={`${formatDay(d, 'long')}${names ? ` (${names})` : ''}`}
                      aria-pressed={selected}
                      aria-current={d === today ? 'date' : undefined}
                      title={names}
                      onClick={() => onPick(d)}
                      className={cx(
                        'relative mx-auto flex size-9 items-center justify-center rounded-full text-sm tabular-nums transition',
                        selected
                          ? 'neon bg-neon font-semibold text-white'
                          : d === today
                            ? 'font-semibold text-brand-700 ring-1 ring-brand-400 ring-inset hover:bg-brand-50'
                            : inMonth
                              ? 'text-slate-800 hover:bg-slate-100'
                              : 'text-slate-400 hover:bg-slate-100',
                        disabled && 'cursor-not-allowed opacity-35 hover:bg-transparent',
                      )}
                    >
                      {DateTime.fromISO(d).day}
                      {names && (
                        <span
                          aria-hidden
                          className={cx(
                            'absolute bottom-1 size-1 rounded-full',
                            selected ? 'bg-white' : 'bg-rose-500',
                          )}
                        />
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex items-center justify-between border-t border-slate-200/70 pt-2 text-xs">
        <button
          type="button"
          disabled={!todayAllowed}
          onClick={() => onPick(today)}
          className="rounded-md px-2 py-1 font-semibold text-brand-600 hover:bg-brand-50 disabled:opacity-40"
        >
          Today
        </button>
        <span className="flex items-center gap-1.5 text-slate-400">
          <span className="size-1.5 rounded-full bg-rose-500" aria-hidden /> Holiday
        </span>
      </div>
    </div>
  );
}

/** A date field that opens a themed calendar. The value is 'YYYY-MM-DD'. */
export function DateInput({
  value,
  onChange,
  min,
  max,
  id,
}: {
  value: ISODate;
  onChange: (day: ISODate) => void;
  min?: ISODate;
  max?: ISODate;
  id?: string;
}) {
  const { invalid, ...field } = useField(id);
  const button = useRef<HTMLButtonElement>(null);
  const valueId = useId();
  // The year only when it isn't this one: "Sat, Sep 26" fits narrow fields.
  const thisYear = todayIn(useViewerZone()).slice(0, 4);
  const shown = DateTime.fromISO(value).toFormat(
    value.startsWith(thisYear) ? 'ccc, LLL d' : 'ccc, LLL d, yyyy',
  );
  const [open, setOpen] = useState(false);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        {...field}
        aria-describedby={[valueId, field['aria-describedby']].filter(Boolean).join(' ')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          controlClass,
          'flex h-10 items-center justify-between gap-2 px-3 text-left',
          invalid && 'ring-rose-400',
        )}
      >
        <span id={valueId} className="truncate">
          {shown}
        </span>
        <CalendarDays className="size-4 shrink-0 text-slate-400" aria-hidden />
      </button>
      {open && (
        <Popover
          anchor={button}
          role="dialog"
          aria-label="Choose a date"
          onClose={(reason) => close(reason === 'escape')}
        >
          <Calendar
            value={value}
            min={min}
            max={max}
            onPick={(day) => {
              onChange(day);
              close(true);
            }}
          />
        </Popover>
      )}
    </>
  );
}
