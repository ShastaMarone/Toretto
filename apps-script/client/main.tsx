// The web app's entry point for the Apps Script build: the same app, with its
// own history (see HistorySync) and the first /bootstrap answer from doGet.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { ApiError } from '../../web/src/api/client';
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
