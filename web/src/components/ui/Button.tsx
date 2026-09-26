import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { cx } from '../../lib/cx';

export type ButtonVariant =
  'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost' | 'success';
type Size = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

const base =
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold transition disabled:pointer-events-none disabled:opacity-50';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-neon text-white neon hover:brightness-110 active:brightness-95',
  secondary:
    'bg-surface/70 text-slate-700 shadow-sm ring-1 ring-inset ring-slate-300 backdrop-blur hover:bg-slate-50 hover:ring-brand-300 dark:ring-slate-200 dark:hover:ring-brand-400/60',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  danger:
    'bg-rose-600 text-white shadow-sm hover:bg-rose-500 dark:bg-rose-500 dark:hover:bg-rose-400 dark:shadow-[0_6px_20px_-6px_rgb(244_63_94/0.65)]',
  'danger-ghost': 'text-rose-600 hover:bg-rose-50',
  success:
    'bg-emerald-600 text-white shadow-sm hover:bg-emerald-500 dark:bg-emerald-400 dark:text-[#04130b] dark:hover:bg-emerald-300 dark:shadow-[0_6px_20px_-6px_rgb(52_211_153/0.6)]',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
  lg: 'h-11 px-5 text-base',
  icon: 'h-10 w-10',
  'icon-sm': 'h-8 w-8',
};

function buttonClass(variant: ButtonVariant = 'secondary', size: Size = 'md', className?: string) {
  return cx(base, variants[variant], sizes[size], className);
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  type = 'button',
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

interface ButtonLinkProps extends LinkProps {
  variant?: ButtonVariant;
  size?: Size;
  icon?: ReactNode;
}

export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  ...props
}: ButtonLinkProps) {
  return (
    <Link className={buttonClass(variant, size, className)} {...props}>
      {icon}
      {children}
    </Link>
  );
}
