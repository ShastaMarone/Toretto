import { formatDateRange, type ISODate } from '@shared/time';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '../ui/Button';

export function WeekNav({
  start,
  end,
  onPrev,
  onNext,
  onToday,
  isCurrent,
  label,
}: {
  start: ISODate;
  end: ISODate;
  onPrev: () => void;
  onNext: () => void;
  onToday?: () => void;
  isCurrent?: boolean;
  label?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center rounded-lg bg-white shadow-sm ring-1 ring-inset ring-slate-300">
        <button
          type="button"
          onClick={onPrev}
          aria-label="Previous"
          className="rounded-l-lg p-2 text-slate-600 hover:bg-slate-50"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="min-w-40 border-x border-slate-200 px-3 text-center text-sm font-semibold text-slate-800 tabular-nums">
          {label ?? formatDateRange(start, end)}
        </span>
        <button
          type="button"
          onClick={onNext}
          aria-label="Next"
          className="rounded-r-lg p-2 text-slate-600 hover:bg-slate-50"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
      {onToday && (
        <Button size="md" onClick={onToday} disabled={isCurrent}>
          Today
        </Button>
      )}
    </div>
  );
}
