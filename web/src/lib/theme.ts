import { useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';

const KEY = 'toretto:theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}

function resolve(preference: ThemePreference): 'light' | 'dark' {
  return preference === 'system' ? (media().matches ? 'dark' : 'light') : preference;
}

/** Same logic as public/theme.js, which runs before first paint. */
function apply(): void {
  const dark = resolve(readPreference()) === 'dark';
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#10111a' : '#9333ea');
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const mq = media();
  const onSystem = () => {
    apply();
    listener();
  };
  mq.addEventListener('change', onSystem);
  return () => {
    listeners.delete(listener);
    mq.removeEventListener('change', onSystem);
  };
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, preference);
  } catch {
    // Not saved (private mode); still applies for this visit.
  }
  apply();
  for (const listener of listeners) listener();
}

/** The person's theme choice (saved on this device) and what it resolves to. */
export function useTheme(): {
  preference: ThemePreference;
  resolved: 'light' | 'dark';
  setPreference: (preference: ThemePreference) => void;
} {
  const preference = useSyncExternalStore(subscribe, readPreference, () => 'system' as const);
  const resolved = useSyncExternalStore(
    subscribe,
    () => resolve(readPreference()),
    () => 'light' as const,
  );
  return { preference, resolved, setPreference: setThemePreference };
}
