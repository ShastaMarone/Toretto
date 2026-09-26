import { Monitor, Moon, Sun } from 'lucide-react';
import { cx } from '../lib/cx';
import { useTheme, type ThemePreference } from '../lib/theme';

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/** Light / dark / follow-the-system switch. Saved on this device. */
export function ThemeToggle({ withLabels = false }: { withLabels?: boolean }) {
  const { preference, setPreference } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex rounded-xl bg-slate-100/80 p-1 ring-1 ring-inset ring-slate-200/60"
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={preference === value}
          aria-label={label}
          title={label}
          onClick={() => setPreference(value)}
          className={cx(
            'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition',
            preference === value
              ? 'bg-surface text-slate-900 shadow-sm dark:bg-brand-600/25 dark:text-brand-900 dark:shadow-[0_0_14px_-4px_var(--glow)]'
              : 'text-slate-500 hover:text-slate-800',
          )}
        >
          <Icon className="size-4" aria-hidden />
          {withLabels && label}
        </button>
      ))}
    </div>
  );
}
