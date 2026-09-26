import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useBootstrap } from '../api/queries';
import { homePath, safeNext, useBootstrapData, useCurrentUser } from '../lib/session';
import { FullPageSpinner } from './ui/Misc';

const SETUP_EXEMPT = ['/setup', '/dev/mailbox', '/check-email', '/set-password'];

/** Loads the session once, and sends a brand-new install to the setup page. */
export function BootstrapGate({ children }: { children: ReactNode }) {
  const { data, error, isLoading, refetch } = useBootstrap();
  const location = useLocation();
  if (isLoading) return <FullPageSpinner />;
  if (error || !data) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-lg font-semibold">Can't reach the scheduling server</p>
        <p className="text-sm text-slate-600">{error?.message}</p>
        <button className="text-sm font-semibold text-brand-600" onClick={() => void refetch()}>
          Try again
        </button>
      </div>
    );
  }
  if (data.setupRequired && !SETUP_EXEMPT.includes(location.pathname))
    return <Navigate to="/setup" replace />;
  return <>{children}</>;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useBootstrapData();
  const location = useLocation();
  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <>{children}</>;
}

export function RequireAdmin() {
  const user = useCurrentUser();
  if (user.role !== 'admin') return <Navigate to="/my-schedule" replace />;
  return <Outlet />;
}

/** Pages for signed-out visitors bounce signed-in people to their home page. */
export function PublicOnly() {
  const { user } = useBootstrapData();
  const location = useLocation();
  if (user) {
    const next = safeNext(new URLSearchParams(location.search).get('next'));
    return <Navigate to={next ?? homePath(user)} replace />;
  }
  return <Outlet />;
}
