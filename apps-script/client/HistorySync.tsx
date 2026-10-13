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
    if ((location.state as { fromHistory?: boolean } | null)?.fromHistory) return;
    const page = location.pathname + location.search;
    if (type === 'PUSH') google.script.history.push(null, { page });
    else google.script.history.replace(null, { page });
  }, [location, type]);

  return null;
}
