import { useEffect } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router';

/**
 * The page lives in Google's frame, so the app keeps its own history (a
 * MemoryRouter). This mirrors each screen into the address bar (?page=/…) for
 * reloads and follows Back and Forward.
 */
export function HistorySync() {
  const location = useLocation();
  const type = useNavigationType();
  const navigate = useNavigate();

  useEffect(() => {
    google.script.history.setChangeHandler((event) => {
      navigate(event.location.parameter.page || '/', {
        replace: true,
        state: { fromHistory: true },
      });
    });
  }, [navigate]);

  useEffect(() => {
    const page = location.pathname + location.search;
    // Also kept in this tab, so a reload comes back here even if the address bar
    // lost ?page= (see startingPage).
    try {
      sessionStorage.setItem(LAST_PAGE, page);
    } catch {
      // Storage can be blocked; the address bar still works.
    }
    if ((location.state as { fromHistory?: boolean } | null)?.fromHistory) return;
    try {
      if (type === 'PUSH') google.script.history.push({ page }, { page });
      else google.script.history.replace({ page }, { page });
    } catch {
      // Not running inside Google's page (or history is unavailable): nothing to mirror.
    }
  }, [location, type]);

  return null;
}

const LAST_PAGE = 'toretto.lastPage';

/**
 * Where to start: the screen in the link (?page=…), else, on a reload, the one
 * this tab was last on, else home.
 */
// Only main.tsx uses this; it's no component, and there's no hot reload in the built page.
// eslint-disable-next-line react-refresh/only-export-components
export function startingPage(fromLink: string | undefined): string {
  if (fromLink && fromLink !== '/') return fromLink;
  try {
    const saved = sessionStorage.getItem(LAST_PAGE);
    if (saved?.startsWith('/')) return saved;
  } catch {
    // Storage can be blocked.
  }
  return '/';
}
