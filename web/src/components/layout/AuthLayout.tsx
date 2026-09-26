import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useBootstrapData } from '../../lib/session';

export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { org, setupRequired } = useBootstrapData();
  return (
    <div className="flex min-h-dvh flex-col items-center bg-gradient-to-b from-indigo-50 via-slate-50 to-slate-50 px-4 py-10 sm:justify-center">
      <div className="mb-6 flex items-center gap-3">
        <img src="/favicon.svg" alt="" className="size-10" />
        <div className="leading-tight">
          <p className="font-bold text-slate-900">{setupRequired ? 'Toretto' : org.name}</p>
          <p className="text-xs text-slate-500">Team scheduling</p>
        </div>
      </div>
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 sm:p-8">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <div className="mt-1.5 text-sm text-slate-500">{subtitle}</div>}
        <div className="mt-6">{children}</div>
      </div>
      {footer && <div className="mt-6 text-center text-sm text-slate-600">{footer}</div>}
    </div>
  );
}

export function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="font-semibold text-indigo-600 hover:text-indigo-500">
      {children}
    </Link>
  );
}
