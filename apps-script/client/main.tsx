// The web app's entry point for the Apps Script build: the same app, with its
// own history (see HistorySync) and the first /bootstrap answer from doGet.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { api, ApiError } from '../../web/src/api/client';
import { keys } from '../../web/src/api/queries';
import App from '../../web/src/App';
import { ThemedToaster } from '../../web/src/components/ThemedToaster';
import { HistorySync } from './HistorySync';
import './styles.css';

const boot = window.__TORETTO__;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Every refresh is a trip to Google and a read of the Sheet. Changes made here
      // refresh what they touch straight away, so only look again after a couple of minutes.
      staleTime: 120_000,
      refetchOnWindowFocus: true,
      retry: (count, error) =>
        !(
          error instanceof ApiError &&
          ((error.status >= 400 && error.status < 500) || error.code === 'TIMEOUT')
        ) && count < 2,
    },
  },
});
// doGet ran /bootstrap already: start from its answer instead of asking again.
if (boot?.bootstrap.status === 200) queryClient.setQueryData(keys.bootstrap, boot.bootstrap.body);

// Every trip to Google costs a couple of seconds however little it carries, so
// once the first screen is up, fetch what the other tabs show in one more trip:
// switching tabs then finds it ready. Only fixed queries (the ones that don't
// depend on a date range); errors are ignored, the tab asks again itself.
function prefetchOtherTabs(role: string | undefined): void {
  const get = <T,>(path: string) => () => api.get<T>(path);
  const queries: [readonly unknown[], () => Promise<unknown>][] = [
    [keys.tiers, get('/tiers')],
    [keys.teams, get('/teams')],
    [keys.labels, get('/labels')],
    [keys.timeOffTypes(false), get('/time-off-types')],
    [keys.schedules, get('/schedules')],
    [keys.settings, get('/admin/settings')],
    [keys.people, get('/users')],
    [keys.overview, get('/admin/overview')],
    [keys.timeOff('pending'), get('/time-off?status=pending')],
    [keys.timeOff('all'), get('/time-off?status=all')],
    [keys.swaps, get('/swaps')],
    [keys.openShifts, get('/open-shifts')],
    [keys.timeOffTypes(true), get('/time-off-types?all=1')],
  ];
  const member: [readonly unknown[], () => Promise<unknown>][] = [
    [keys.timeOffTypes(false), get('/time-off-types')],
    [keys.myTimeOff, get('/my/time-off')],
    [keys.mySwaps, get('/my/swaps')],
    [keys.myOpenShifts, get('/my/open-shifts')],
  ];
  for (const [queryKey, queryFn] of role === 'admin' ? queries : member) {
    void queryClient.prefetchQuery({ queryKey, queryFn }).catch(() => undefined);
  }
}

/** Wait until the screen's own requests are done, so these don't slow them down. */
function prefetchWhenIdle(role: string | undefined, tries = 0): void {
  setTimeout(
    () => {
      if (queryClient.isFetching() > 0 && tries < 10) prefetchWhenIdle(role, tries + 1);
      else prefetchOtherTabs(role);
    },
    tries === 0 ? 1500 : 1000,
  );
}
if (boot?.bootstrap.status === 200) {
  prefetchWhenIdle((boot.bootstrap.body as { user?: { role?: string } | null }).user?.role);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[boot?.path || '/']}>
        <HistorySync />
        <App />
      </MemoryRouter>
      <ThemedToaster />
    </QueryClientProvider>
  </StrictMode>,
);
