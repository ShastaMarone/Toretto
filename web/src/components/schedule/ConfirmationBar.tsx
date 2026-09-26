export function ConfirmationBar({ confirmed, total }: { confirmed: number; total: number }) {
  const pct = total ? Math.round((confirmed / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2" title={`${confirmed} of ${total} shifts confirmed`}>
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-200">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-slate-500">
        {confirmed}/{total} confirmed
      </span>
    </div>
  );
}
