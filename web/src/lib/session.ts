import type { Bootstrap, SessionUser, TimeFormat } from '@shared/types';
import { useQueryClient } from '@tanstack/react-query';
import { keys, useBootstrap } from '../api/queries';

export function homePath(user: Pick<SessionUser, 'role'>): string {
  return user.role === 'admin' ? '/admin' : '/my-schedule';
}

/** Only same-site relative paths are allowed as post-login redirects. */
export function safeNext(next: string | null | undefined): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\'))
    return null;
  return next;
}

export function useBootstrapData(): Bootstrap {
  const { data } = useBootstrap();
  if (!data) throw new Error('Bootstrap data is not loaded');
  return data;
}

export function useCurrentUser(): SessionUser {
  const { user } = useBootstrapData();
  if (!user) throw new Error('Not signed in');
  return user;
}

/** The zone the signed-in person sees times in. */
export function useViewerZone(): string {
  const { user, org } = useBootstrapData();
  return user?.timezone ?? org.timezone;
}

/** Whether the signed-in person reads times as "3:00 PM" or "15:00". */
export function useTimeFormat(): TimeFormat {
  const { user, org } = useBootstrapData();
  return user?.timeFormat ?? org.timeFormat;
}

/** Call after any auth change (login, logout, profile edit) to refresh the session. */
export function useSetSessionUser() {
  const queryClient = useQueryClient();
  return (user: SessionUser | null) => {
    queryClient.setQueryData<Bootstrap>(keys.bootstrap, (old) =>
      old ? { ...old, user, setupRequired: false } : old,
    );
    if (!user) queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'bootstrap' });
    void queryClient.invalidateQueries({ queryKey: keys.bootstrap });
  };
}
