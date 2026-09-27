import type { ScheduleSummary } from '@shared/types';
import { Check, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cx } from '../../lib/cx';
import { moveMenuFocus } from '../ui/menuKeys';
import { Popover } from '../ui/Popover';

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
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  // Start on the schedule that's showing.
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  const item =
    'flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 outline-none hover:bg-slate-100 focus-visible:bg-slate-100 [&>svg]:size-4';
  const pick = (action: () => void) => {
    close(true);
    action();
  };
  return (
    <>
      <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
        <button
          ref={button}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => (open ? close(false) : setOpen(true))}
          className="group -ml-2 flex items-center gap-1.5 rounded-lg px-2 py-1 text-left hover:bg-slate-100/80"
        >
          {current.name}
          <ChevronDown
            className={cx(
              'size-5 text-slate-400 transition group-hover:text-brand-600',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        </button>
      </h1>
      {open && (
        <Popover anchor={button} onClose={(reason) => close(reason === 'escape')}>
          <div
            ref={list}
            role="menu"
            aria-label="Schedules"
            onKeyDown={(e) => {
              if (moveMenuFocus(e, list.current)) return;
              if (e.key === 'Tab') close(true);
            }}
            className="w-64 py-1"
          >
            <p
              aria-hidden
              className="px-3 pt-1.5 pb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase"
            >
              Schedules
            </p>
            {schedules.map((s) => (
              <button
                key={s.id}
                type="button"
                role="menuitemradio"
                aria-checked={s.id === current.id}
                onClick={() => pick(() => onSelect(s.id))}
                className={item}
              >
                <span className="flex-1 truncate">{s.name}</span>
                {s.pendingChanges > 0 && (
                  <span className="rounded-full bg-amber-100 px-1.5 text-[11px] font-semibold text-amber-800">
                    {s.pendingChanges}
                    <span className="sr-only"> unpublished changes</span>
                  </span>
                )}
                {s.id === current.id && <Check className="text-brand-600" aria-hidden />}
              </button>
            ))}
            <div role="separator" className="my-1 border-t border-slate-200/70" />
            <button type="button" role="menuitem" onClick={() => pick(onCreate)} className={item}>
              <Plus aria-hidden /> New schedule…
            </button>
            <button type="button" role="menuitem" onClick={() => pick(onRename)} className={item}>
              <Pencil aria-hidden /> Rename…
            </button>
            {!current.isDefault && (
              <button
                type="button"
                role="menuitem"
                onClick={() => pick(onDelete)}
                className={cx(item, 'text-rose-600 hover:bg-rose-50 focus-visible:bg-rose-50')}
              >
                <Trash2 aria-hidden /> Delete schedule
              </button>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}
