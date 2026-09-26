import { Check, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { colorFor, initials, PALETTE } from '../../lib/colors';
import { cx } from '../../lib/cx';

export type Tone = 'gray' | 'green' | 'amber' | 'red' | 'brand' | 'blue' | 'purple';

const tones: Record<Tone, string> = {
  gray: 'bg-slate-100 text-slate-700 ring-slate-500/15',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  red: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  brand: 'bg-brand-50 text-brand-700 ring-brand-600/20',
  blue: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  purple: 'bg-violet-50 text-violet-700 ring-violet-600/20',
};

export function Badge({
  tone = 'gray',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('glass underglow rounded-2xl ring-1 ring-slate-200/80', className)}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      className={cx('size-5 animate-spin text-slate-400', className)}
      aria-label="Loading"
    />
  );
}

export function FullPageSpinner() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Spinner className="size-8" />
    </div>
  );
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
      <Spinner /> {label}
    </div>
  );
}

export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center text-sm">
      <p className="font-medium text-slate-800">Couldn't load this page</p>
      <p className="text-slate-500">{error instanceof Error ? error.message : 'Unknown error'}</p>
      {onRetry && (
        <button className="font-semibold text-brand-600 hover:text-brand-500" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-col items-center px-6 py-12 text-center', className)}>
      {icon && (
        <div className="mb-3 rounded-full bg-slate-100 p-3 text-slate-500 [&>svg]:size-6">
          {icon}
        </div>
      )}
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">{title}</h1>
          {description && <div className="mt-1 text-sm text-slate-500">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const dims = { sm: 'size-6 text-[10px]', md: 'size-8 text-xs', lg: 'size-10 text-sm' }[size];
  return (
    <span
      aria-hidden
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white',
        dims,
        className,
      )}
      style={{ backgroundColor: colorFor(name) }}
    >
      {initials(name)}
    </span>
  );
}

export function ColorDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx('inline-block size-2.5 shrink-0 rounded-full', className)}
      style={{ backgroundColor: color }}
    />
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode; count?: number }[];
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cx(
        'flex gap-1 overflow-x-auto rounded-xl bg-slate-100/80 p-1 ring-1 ring-inset ring-slate-200/60 backdrop-blur scrollbar-thin',
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          type="button"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition',
            o.value === value
              ? 'bg-surface text-slate-900 shadow-sm dark:bg-brand-600/25 dark:text-brand-900 dark:shadow-[0_0_18px_-6px_var(--glow)] dark:ring-1 dark:ring-inset dark:ring-brand-400/40'
              : 'text-slate-600 hover:text-slate-900',
          )}
        >
          {o.label}
          {o.count !== undefined && o.count > 0 && (
            <span className="rounded-full bg-brand-100 px-1.5 text-xs font-semibold text-brand-700">
              {o.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** A small dropdown for overflow actions. */
export function Menu({
  trigger,
  items,
  label,
}: {
  trigger: ReactNode;
  items: MenuItem[];
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-surface/70 text-slate-600 shadow-sm ring-1 ring-inset ring-slate-300 backdrop-blur hover:bg-slate-50 dark:ring-slate-200"
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          className="glass absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-xl py-1 shadow-xl ring-1 ring-slate-200"
        >
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              type="button"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cx(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm disabled:opacity-50 [&>svg]:size-4',
                item.danger
                  ? 'text-rose-600 hover:bg-rose-50'
                  : 'text-slate-700 hover:bg-slate-100',
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ColorPicker({
  value,
  onChange,
  label = 'Color',
}: {
  value: string;
  onChange: (color: string) => void;
  label?: string;
}) {
  const custom = !PALETTE.includes(value.toLowerCase());
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-slate-700">{label}</legend>
      <div className="flex flex-wrap items-center gap-2">
        {PALETTE.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={color}
            aria-pressed={value.toLowerCase() === color}
            onClick={() => onChange(color)}
            className="flex size-7 items-center justify-center rounded-full ring-offset-2 transition hover:scale-110 aria-pressed:ring-2 aria-pressed:ring-slate-900"
            style={{ backgroundColor: color }}
          >
            {value.toLowerCase() === color && <Check className="size-4 text-white" />}
          </button>
        ))}
        <label
          className={cx(
            'relative flex size-7 cursor-pointer items-center justify-center overflow-hidden rounded-full ring-1 ring-slate-300 ring-offset-2',
            custom && 'ring-2 ring-slate-900',
          )}
          title="Custom color"
          style={{
            background: custom
              ? value
              : 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)',
          }}
        >
          <span className="sr-only">Custom color</span>
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
      </div>
    </fieldset>
  );
}
