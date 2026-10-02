import { useState } from 'react';

function read(storageKey: string | undefined): Set<string> {
  if (!storageKey) return new Set();
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return new Set(
      Array.isArray(saved) ? saved.filter((k): k is string => typeof k === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

/**
 * Which tier sections are collapsed. Pass a `storageKey` to keep the choice on
 * this device, so leaving the page and coming back finds the sections as they
 * were; without one it only lasts while the page is open.
 */
export function useCollapsedGroups(storageKey?: string): [Set<string>, (key: string) => void] {
  const [collapsed, setCollapsed] = useState(() => read(storageKey));
  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify([...next]));
    } catch {
      // Not remembered, but it still works for now.
    }
  };
  return [collapsed, toggle];
}
