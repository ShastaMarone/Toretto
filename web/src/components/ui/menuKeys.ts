import type { KeyboardEvent } from 'react';

/**
 * Keyboard moves inside an open menu: arrows go to the next or previous item
 * (wrapping), Home and End to the first and last. Returns whether it handled
 * the key. Disabled items are skipped.
 */
export function moveMenuFocus(e: KeyboardEvent<HTMLElement>, menu: HTMLElement | null): boolean {
  const items = [...(menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]:enabled') ?? [])];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const targets: Record<string, number> = {
    ArrowDown: at + 1,
    ArrowUp: at - 1,
    Home: 0,
    End: items.length - 1,
  };
  const target = targets[e.key];
  if (target === undefined || items.length === 0) return false;
  e.preventDefault();
  items[(target + items.length) % items.length]?.focus();
  return true;
}
