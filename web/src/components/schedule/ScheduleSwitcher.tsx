import type { ScheduleSummary } from '@shared/types';
import { Check, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cx } from '../../lib/cx';

/** The schedule's name as a dropdown: switch schedules, add, rename or delete one. */
export function ScheduleSwitcher({
  current,
  schedules,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  current: ScheduleSummary;
  schedules: ScheduleSummary[];
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const item =
    'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-100 [&>svg]:size-4';
  const act = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div ref={ref} className="relative">
      <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="group -ml-2 flex items-center gap-1.5 rounded-lg px-2 py-1 text-left hover:bg-slate-100/80"
        >
          {current.name}
          <ChevronDown
            className="size-5 text-slate-400 transition group-hover:text-brand-600"
            aria-hidden
          />
        </button>
      </h1>
      {open && (
        <div
          role="menu"
          className="glass absolute left-0 z-30 mt-1 w-64 overflow-hidden rounded-xl py-1 shadow-xl ring-1 ring-slate-200"
        >
          <p className="px-3 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Schedules
          </p>
          {schedules.map((s) => (
            <button
              key={s.id}
              role="menuitemradio"
              aria-checked={s.id === current.id}
              type="button"
              onClick={act(() => onSelect(s.id))}
              className={cx(item, 'text-slate-700')}
            >
              <span className="flex-1 truncate">{s.name}</span>
              {s.pendingChanges > 0 && (
                <span className="rounded-full bg-amber-100 px-1.5 text-[11px] font-semibold text-amber-800">
                  {s.pendingChanges}
                </span>
              )}
              {s.id === current.id && <Check className="text-brand-600" />}
            </button>
          ))}
          <div className="my-1 border-t border-slate-200/70" />
          <button
            role="menuitem"
            type="button"
            onClick={act(onCreate)}
            className={cx(item, 'text-slate-700')}
          >
            <Plus /> New schedule…
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={act(onRename)}
            className={cx(item, 'text-slate-700')}
          >
            <Pencil /> Rename…
          </button>
          {!current.isDefault && (
            <button
              role="menuitem"
              type="button"
              onClick={act(onDelete)}
              className={cx(item, 'text-rose-600 hover:bg-rose-50')}
            >
              <Trash2 /> Delete schedule
            </button>
          )}
        </div>
      )}
    </div>
  );
}
