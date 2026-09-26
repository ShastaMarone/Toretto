import {
  useEffect,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';
import { cx } from '../../lib/cx';

export type CloseReason = 'escape' | 'outside';

const GAP = 4;
const MARGIN = 8;

/** Safari before 17 has no Popover API; the panel then opens as a plain fixed layer. */
const topLayer = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

/**
 * A panel anchored to another element, drawn in the browser's top layer (the
 * Popover API): no card edge can clip it, it stays above modal dialogs, and
 * its buttons keep working inside them. Mount it to open; unmount to close.
 * It opens below the anchor (or above, when there's more room there), stays
 * on screen, and follows the anchor while the page scrolls.
 */
export function Popover({
  anchor,
  onClose,
  align = 'start',
  matchWidth = false,
  maxHeight,
  className,
  style,
  children,
  ...props
}: {
  anchor: RefObject<HTMLElement | null>;
  /** Escape was pressed, or someone pressed outside both panel and anchor. */
  onClose: (reason: CloseReason) => void;
  align?: 'start' | 'end';
  /** Be exactly as wide as the anchor. */
  matchWidth?: boolean;
  /** Tallest the panel may get (it scrolls beyond that). */
  maxHeight?: number;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'popover'>) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });

  // Open and place it before the browser paints, so it never shows in the
  // wrong spot and whoever opened it can move focus into it straight away.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (topLayer && !el.matches(':popover-open')) el.showPopover();
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      if (!a) return;
      // Where top/left 0 lands: the viewport, unless (without the top layer)
      // an ancestor such as a blurred dialog is what "fixed" is relative to.
      el.style.top = '0px';
      el.style.left = '0px';
      const origin = el.getBoundingClientRect();
      if (matchWidth) el.style.width = `${a.width}px`;
      const w = el.offsetWidth;
      const below = window.innerHeight - MARGIN - (a.bottom + GAP);
      const above = a.top - GAP - MARGIN;
      const natural = el.scrollHeight;
      const limit = maxHeight ?? Infinity;
      const openBelow = Math.min(natural, limit) <= below || below >= above;
      const room = Math.max(96, Math.min(limit, openBelow ? below : above));
      const height = Math.min(natural, room);
      const top = openBelow ? a.bottom + GAP : a.top - GAP - height;
      const left = Math.max(
        MARGIN,
        Math.min(align === 'end' ? a.right - w : a.left, window.innerWidth - MARGIN - w),
      );
      el.style.maxHeight = `${room}px`;
      el.style.top = `${top - origin.top}px`;
      el.style.left = `${left - origin.left}px`;
    };
    place();
    // Scrolling inside the panel itself doesn't move it.
    const onScroll = (e: Event) => {
      if (!el.contains(e.target as Node)) place();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
      if (topLayer && el.matches(':popover-open')) el.hidePopover();
    };
  }, [anchor, align, matchWidth, maxHeight]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !anchor.current?.contains(target))
        closeRef.current('outside');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Close only this panel, not a dialog it's in.
      e.preventDefault();
      e.stopPropagation();
      closeRef.current('escape');
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [anchor]);

  return (
    <div
      ref={ref}
      popover={topLayer ? 'manual' : undefined}
      {...props}
      // top, left, width and max-height are set when it's placed.
      style={{ ...style, position: 'fixed', inset: 'auto', margin: 0 }}
      className={cx(
        'z-50 overflow-y-auto overscroll-contain rounded-xl border-0 bg-surface p-0 text-slate-900 shadow-xl ring-1 ring-slate-200 scrollbar-thin dark:shadow-[0_18px_50px_-12px_var(--glow)]',
        className,
      )}
    >
      {children}
    </div>
  );
}
