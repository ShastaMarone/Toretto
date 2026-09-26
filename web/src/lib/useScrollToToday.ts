import { useEffect, useRef } from 'react';

/**
 * For a calendar wider than the screen: when the range changes, scroll so
 * today's column is in view (with a couple of days before it), or back to
 * the start. Attach the ref to the scrolling element.
 */
export function useScrollToToday<T extends HTMLElement>(rangeKey: string) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const today = el.querySelector<HTMLElement>('th[data-today]');
    const nameColumn = el.querySelector<HTMLElement>('thead th')?.offsetWidth ?? 0;
    el.scrollLeft = today ? Math.max(0, today.offsetLeft - nameColumn - 2 * today.offsetWidth) : 0;
  }, [rangeKey]);
  return ref;
}
