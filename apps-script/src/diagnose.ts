// diagnose(): run from the Apps Script editor to see where time goes on the
// real Sheet. It times what the Scheduler page asks for, one step at a time,
// and logs the result (View → Logs, or the Execution log at the bottom).
import { TABLES } from './db/schema';
import { Db, SPREADSHEET_ID } from './db/store';

type Run = (method: string, url: string, body: string | null) => string;

export function diagnose(api: Run): string {
  const lines: string[] = [];
  const started = Date.now();
  const step = (label: string, fn: () => string | void) => {
    const t0 = Date.now();
    let note: string;
    try {
      note = fn() || '';
    } catch (err) {
      note = `FAILED: ${err instanceof Error ? err.message : String(err)}`;
    }
    lines.push(`${String(Date.now() - t0).padStart(7)} ms  ${label}${note ? `  ${note}` : ''}`);
  };

  const props = PropertiesService.getScriptProperties();
  step('script properties', () => `${Object.keys(props.getProperties()).length} saved`);
  step('lock (get and release)', () => {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(20_000)) return 'COULD NOT GET THE LOCK in 20 s: something is holding it';
    lock.releaseLock();
  });
  step('cache (write and read)', () => {
    const cache = CacheService.getScriptCache();
    cache.put('toretto:diagnose', 'x', 60);
    return cache.get('toretto:diagnose') === 'x' ? 'works' : 'DID NOT WORK';
  });

  const id = props.getProperty(SPREADSHEET_ID);
  if (!id) return 'Not set up yet: run setup first.';
  let db: Db | null = null;
  step('open the spreadsheet', () => {
    db = new Db();
    return db.spreadsheet().getName();
  });
  for (const def of TABLES) {
    step(`read tab ${def.name}`, () => {
      const values = db!.sheet(def.name).getDataRange().getValues();
      const cells = values.reduce((n, row) => n + row.length, 0);
      return `${Math.max(0, values.length - 1)} rows, ${cells} cells`;
    });
  }

  // What the Scheduler page asks for, in the order it does (twice: cold, then cached).
  let schedule = '';
  const call = (url: string) => () => {
    const res = JSON.parse(api('GET', url, null)) as { status: number; body?: unknown };
    if (url === '/schedules' && Array.isArray(res.body)) {
      schedule =
        (res.body as { id: string; isDefault: boolean }[]).find((s) => s.isDefault)?.id ?? '';
    }
    return `status ${res.status}, ${JSON.stringify(res.body ?? '').length} characters`;
  };
  const day = new Date().toISOString().slice(0, 10);
  const later = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  for (const round of ['first', 'again']) {
    step(`[${round}] /bootstrap`, call('/bootstrap'));
    step(`[${round}] /schedules`, call('/schedules'));
    step(`[${round}] the schedule for two weeks`, () =>
      call(`/schedules/${schedule}?from=${day}&to=${later}`)(),
    );
    step(`[${round}] /tiers`, call('/tiers'));
    step(`[${round}] /teams`, call('/teams'));
    step(`[${round}] /admin/settings`, call('/admin/settings'));
    step(`[${round}] /open-shifts`, call('/open-shifts'));
    step(`[${round}] /team/schedule`, call(`/team/schedule?from=${day}&to=${later}`));
  }

  lines.push(`${String(Date.now() - started).padStart(7)} ms  TOTAL`);
  const report = lines.join('\n');
  console.log(report);
  return report;
}
