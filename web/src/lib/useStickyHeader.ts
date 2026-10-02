import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Where a copy of the header should float: in screen coordinates. */
export interface StuckHeader {
  top: number;
  left: number;
  width: number;
  /** The real table's width, so the copy's columns line up. */
  tableWidth: number;
}

/** The phone layout has its own bar across the top of the screen. */
const topOffset = () => (window.matchMedia('(min-width: 1024px)').matches ? 0 : 56);

/**
 * A table inside a sideways-scrolling box can't pin its header to the top of the
 * page with CSS. So: once the real header scrolls above the top of the screen
 * (and the table is still on screen), say where a copy should float; it
 * follows the box's sideways scrolling. `stuck` is null while the real header is visible.
 */
export function useStickyHeader(
  scroller: RefObject<HTMLElement | null>,
  header: RefObject<HTMLElement | null>,
) {
  const [stuck, setStuck] = useState<StuckHeader | null>(null);
  const copy = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => {
      const box = scroller.current;
      const head = header.current;
      const table = head?.closest('table');
      if (!box || !head || !table) return;
      const top = topOffset();
      const headRect = head.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const show = headRect.top < top && tableRect.bottom > top + headRect.height + 24;
      const next = show
        ? { top, left: boxRect.left, width: box.clientWidth, tableWidth: tableRect.width }
        : null;
      setStuck((prev) =>
        prev === next ||
        (prev &&
          next &&
          prev.top === next.top &&
          Math.abs(prev.left - next.left) < 0.5 &&
          Math.abs(prev.width - next.width) < 0.5 &&
          Math.abs(prev.tableWidth - next.tableWidth) < 0.5)
          ? prev
          : next,
      );
    };
    const syncSideways = () => {
      if (copy.current && scroller.current) copy.current.scrollLeft = scroller.current.scrollLeft;
    };
    const box = scroller.current;
    // Capture: the page may scroll inside a wrapper rather than the window itself.
    window.addEventListener('scroll', update, { passive: true, capture: true });
    window.addEventListener('resize', update);
    box?.addEventListener('scroll', syncSideways, { passive: true });
    // The menu collapsing or the data loading changes the box's size without a scroll.
    const resize = new ResizeObserver(update);
    if (box) resize.observe(box);
    update();
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      box?.removeEventListener('scroll', syncSideways);
      resize.disconnect();
    };
  }, [scroller, header]);

  // When the copy appears, line it up with wherever the box is scrolled to.
  useLayoutEffect(() => {
    if (stuck && copy.current && scroller.current) {
      copy.current.scrollLeft = scroller.current.scrollLeft;
    }
  }, [stuck, scroller]);

  return { stuck, copy };
}
