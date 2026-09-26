import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from '../../lib/cx';
import { controlClass, FieldContext, useField } from './field';

export function Field({
  label,
  hint,
  error,
  className,
  children,
  optional,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
  children: ReactNode;
  optional?: boolean;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  return (
    <FieldContext
      value={{ id, describedBy: error || hint ? descId : undefined, invalid: Boolean(error) }}
    >
      <div className={className}>
        <label
          htmlFor={id}
          className="mb-1.5 flex items-baseline justify-between text-sm font-medium text-slate-700"
        >
          <span>{label}</span>
          {optional && <span className="text-xs font-normal text-slate-400">Optional</span>}
        </label>
        {children}
        {(error || hint) && (
          <p
            id={descId}
            className={cx('mt-1.5 text-xs', error ? 'text-rose-600' : 'text-slate-500')}
          >
            {error || hint}
          </p>
        )}
      </div>
    </FieldContext>
  );
}

export function Input({ className, id, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const { invalid, ...aria } = useField(id);
  return (
    <input
      {...aria}
      className={cx(controlClass, 'h-10 px-3', invalid && 'ring-rose-400', className)}
      {...props}
    />
  );
}

export function Select({
  className,
  id,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const { invalid, ...aria } = useField(id);
  return (
    <select
      {...aria}
      className={cx(controlClass, 'h-10 pl-3 pr-8', invalid && 'ring-rose-400', className)}
      {...props}
    >
      {children}
    </select>
  );
}

export function Textarea({ className, id, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { invalid, ...aria } = useField(id);
  return (
    <textarea
      {...aria}
      className={cx(controlClass, 'min-h-20 px-3 py-2', invalid && 'ring-rose-400', className)}
      {...props}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p id={id} className="text-sm font-medium text-slate-800">
          {label}
        </p>
        {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-0.5 inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors disabled:opacity-50',
          checked ? 'neon bg-brand-600' : 'bg-slate-200',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform',
            checked && 'translate-x-5',
          )}
        />
      </button>
    </div>
  );
}

/** Shows server validation errors: form-level message plus per-field messages. */
export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200"
    >
      {message}
    </div>
  );
}
