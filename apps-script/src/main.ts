// Entry points Apps Script calls: the web page (doGet), the page's API calls
// (api, apiBatch), setup() from the editor, and the timed jobs.
import './polyfills';
import { DEFAULT_LABELS, DEFAULT_TIERS } from '../../server/src/services/defaults';
import { diagnose as runDiagnose } from './diagnose';
import { authUser, DEFAULT_SETTINGS, ORG_ID, tables, type Ctx } from './core';
import { Db, ensureSchema, SPREADSHEET_ID } from './db/store';
import { APP_URL, appUrl } from './env';
import { errorResponse, splitUrl, type ApiResponse } from './http';
import { createRouter } from './routes';
import { calendarsInUse, syncCalendars } from './services/calendar';
import { markEmailsWaiting, runHourlyJobs, sendQueuedEmails as sendEmails } from './services/jobs';
import { nameFromEmail } from './services/people';

/** Bump when a new version adds tabs or columns: the next change adds them to the Sheet. */
export const SCHEMA_VERSION = '2';

/**
 * Which build this is. build.mjs stamps the same version into Code.gs and
 * index.html, which are pasted into Apps Script separately and must match.
 * Unstamped when run from source (tests, the local preview).
 */
const VERSION = '__TORETTO_VERSION__';
const stamped = !VERSION.startsWith('__');

const router = createRouter();

function context(db: Db): Ctx {
  const email = (Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  const row = email
    ? tables(db).users.find((u) => u.email === email && !u.deactivatedAt)
    : undefined;
  return { db, now: db.now, email, user: row ? authUser(row) : null, appUrl: appUrl(), queued: 0 };
}

/** Changes need the lock; so does /bootstrap, which marks first visits. */
const writes = (method: string, url: string) =>
  method !== 'GET' || splitUrl(url).path === '/bootstrap';

interface Result extends ApiResponse {
  /** Emails were queued, or calendars may need changes: the page asks for that to happen now. */
  queued?: number;
}

/** Slower than this is worth a line in Executions (the Apps Script editor's log). */
const SLOW_MS = 4000;

function run(method: string, url: string, body: unknown): Result {
  const started = Date.now();
  const res = runTimed(method, url, body);
  const took = Date.now() - started;
  if (took > SLOW_MS) console.warn(`Slow: ${method} ${url} took ${took} ms (status ${res.status})`);
  return res;
}

function runTimed(method: string, url: string, body: unknown): Result {
  const write = writes(method, url);
  const lock = write ? LockService.getScriptLock() : null;
  if (lock && !lock.tryLock(30_000)) {
    return {
      status: 503,
      body: { error: { code: 'BUSY', message: 'Lots going on right now. Please try again.' } },
    };
  }
  try {
    // Reads come from the cache; anything that may change the Sheet reads the Sheet itself.
    const db = write ? new Db() : Db.reader();
    if (write) migrateIfNeeded(db);
    const ctx = context(db);
    const res = router.handle(method, url, body, ctx);
    // A failed request saves nothing (like a rolled-back transaction).
    const saved = write && res.status < 400;
    if (saved) db.commit();
    const calendars = saved && method !== 'GET' && calendarsInUse(db) ? 1 : 0;
    // Still under the lock: emails are waiting to be sent (see sendQueuedEmails).
    if (saved && ctx.queued > 0) markEmailsWaiting();
    return { ...res, queued: saved ? ctx.queued + calendars : 0 };
  } catch (err) {
    return errorResponse(err);
  } finally {
    lock?.releaseLock();
  }
}

function migrateIfNeeded(db: Db): void {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SCHEMA_VERSION') === SCHEMA_VERSION) return;
  ensureSchema(db.spreadsheet());
  props.setProperty('SCHEMA_VERSION', SCHEMA_VERSION);
}

/** google.script.run.api(method, url, bodyJson): the Express API's contract, as JSON text. */
export function api(method: string, url: string, bodyJson: string | null): string {
  const body = bodyJson ? JSON.parse(bodyJson) : undefined;
  return JSON.stringify(run(method, url, body));
}

/** Several reads at once (the page batches the ones it makes together): one round trip. */
export function apiBatch(callsJson: string): string {
  const started = Date.now();
  const calls = JSON.parse(callsJson) as [string, string][];
  const results: ApiResponse[] = new Array(calls.length);
  // Anything that may change the Sheet (like /bootstrap) goes first, on its own.
  calls.forEach(([method, url], i) => {
    if (writes(method, url)) results[i] = run(method, url, undefined);
  });
  // The reads share one connection to the Sheet and read each tab once.
  const db = Db.reader();
  let ctx: Ctx | null = null;
  calls.forEach(([method, url], i) => {
    if (results[i]) return;
    try {
      ctx ??= context(db);
      results[i] = router.handle(method, url, undefined, ctx);
    } catch (err) {
      results[i] = errorResponse(err);
    }
  });
  const took = Date.now() - started;
  if (took > SLOW_MS) console.warn(`Slow: batch of ${calls.length} reads took ${took} ms`);
  return JSON.stringify(results);
}

/** A value as JSON that's safe inside a <script> block. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

/** The web page. Links in emails open a screen: …/exec?page=/my-schedule, …?page=/confirm-shift/<id>. */
export function doGet(e: GoogleAppsScript.Events.DoGet): GoogleAppsScript.HTML.HtmlOutput {
  const url = ScriptApp.getService().getUrl();
  const props = PropertiesService.getScriptProperties();
  if (url && url.endsWith('/exec') && props.getProperty(APP_URL) !== url) {
    props.setProperty(APP_URL, url);
  }
  const params = e?.parameter ?? {};
  const rest = e?.queryString
    ? e.queryString
        .split('&')
        .filter((pair) => !pair.startsWith('page='))
        .join('&')
    : '';
  const path = params.page || `/${e?.pathInfo ?? ''}${rest ? `?${rest}` : ''}`;
  if (!props.getProperty(SPREADSHEET_ID)) {
    return notice(
      'Almost there: run setup',
      "This app isn't set up yet. In the Apps Script editor, pick <b>setup</b> in the " +
        'function menu next to <b>Debug</b>, click <b>Run</b>, and allow the permissions it asks for.',
      'Then reload this page.',
    );
  }
  const boot = run('GET', '/bootstrap', undefined);
  const page = HtmlService.createHtmlOutputFromFile('index').getContent();
  const pageVersion = /<meta name="toretto-version" content="([\w-]+)"/.exec(page)?.[1];
  if (stamped && pageVersion !== VERSION) return versionMismatch(pageVersion);
  const orgName = (boot.body as { org?: { name?: string } } | undefined)?.org?.name;
  return HtmlService.createHtmlOutput(
    page.replace(
      '<!--TORETTO_BOOT-->',
      `<script>window.__TORETTO__=${scriptJson({ path, bootstrap: boot })}</script>`,
    ),
  )
    .setTitle(orgName ? `${orgName} · Scheduling` : 'Toretto Scheduling')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** A page from another build could call things this Code.gs doesn't have. */
function versionMismatch(pageVersion: string | undefined): GoogleAppsScript.HTML.HtmlOutput {
  const index = pageVersion ? `version ${pageVersion}` : 'from an older version';
  return notice(
    'This schedule app needs a quick fix',
    `Its files don't match: Code.gs is version ${VERSION}, but index.html is ${index}.`,
    'Whoever set it up: copy Code.gs and index.html from the same version of ' +
      'apps-script/build, then deploy a new version.',
  );
}

/** A plain page for when the app can't start. */
function notice(title: string, ...paragraphs: string[]): GoogleAppsScript.HTML.HtmlOutput {
  return HtmlService.createHtmlOutput(
    '<div style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 16px">' +
      `<h1 style="font-size:20px">${title}</h1>` +
      paragraphs.map((p) => `<p>${p}</p>`).join('') +
      '</div>',
  )
    .setTitle('Toretto Scheduling')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Run from the editor to time what the Scheduler page does, on your real Sheet. */
export function diagnose(): string {
  return runDiagnose(api);
}

/**
 * Run once from the Apps Script editor (and again after updating the code):
 * connects the Sheet, creates its tabs, makes you the first admin, and
 * starts the timed jobs. Safe to run again.
 */
export function setup(): string {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(SPREADSHEET_ID);
  let book: GoogleAppsScript.Spreadsheet.Spreadsheet;
  if (id) {
    book = SpreadsheetApp.openById(id);
  } else {
    book = SpreadsheetApp.getActiveSpreadsheet() ?? SpreadsheetApp.create('Toretto data');
    props.setProperty(SPREADSHEET_ID, book.getId());
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30_000);
  const report: string[] = [];
  try {
    report.push(...ensureSchema(book));
    props.setProperty('SCHEMA_VERSION', SCHEMA_VERSION);
    const db = new Db();
    db.invalidateCache(); // setup also makes the app look at the Sheet afresh
    const t = tables(db);
    if (!t.settings.get(ORG_ID)) {
      t.settings.insert({
        id: ORG_ID,
        ...DEFAULT_SETTINGS,
        timezone: Session.getScriptTimeZone() || DEFAULT_SETTINGS.timezone,
      });
      report.push('Added the organization settings');
    }
    if (!t.schedules.find((s) => s.isDefault)) {
      t.schedules.insert({ name: 'Main schedule', isDefault: true });
      report.push('Added the Main schedule');
    }
    if (!t.timeOffTypes.all().length) {
      const types = [
        ['Paid Holiday', '#0ea5e9', true],
        ['Personal Day', '#8b5cf6', true],
        ['Vacation', '#10b981', true],
        ['Sick Day', '#f59e0b', true],
        ['Unpaid Leave', '#64748b', false],
      ] as const;
      types.forEach(([name, color, paid], i) =>
        t.timeOffTypes.insert({ name, color, paid, sortOrder: i + 1 }),
      );
      report.push('Added the time-off types');
    }
    if (!t.tiers.all().length) {
      DEFAULT_TIERS.forEach((tier, i) => t.tiers.insert({ ...tier, sortOrder: i + 1 }));
      DEFAULT_LABELS.forEach((label) => t.labels.insert({ ...label, tierId: null }));
      report.push('Added starter tiers and labels');
    }
    const owner = (Session.getEffectiveUser().getEmail() || '').toLowerCase();
    if (owner && !t.users.find((u) => u.email === owner)) {
      t.users.insert({
        name: nameFromEmail(owner),
        email: owner,
        role: 'admin',
        emailVerifiedAt: db.now,
      });
      report.push(`Made ${owner} an admin`);
    }
    db.commit();
  } finally {
    lock.releaseLock();
  }
  // Timed jobs: emails every 5 minutes, the rest hourly.
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (['sendQueuedEmails', 'runHourlyJobs'].includes(trigger.getHandlerFunction())) {
      ScriptApp.deleteTrigger(trigger);
    }
  }
  ScriptApp.newTrigger('sendQueuedEmails').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('runHourlyJobs').timeBased().everyHours(1).create();
  report.push('Started the timed jobs (emails every 5 minutes, reminders and tidying hourly)');
  const check = checkTimeZones();
  report.push(check);
  const summary = `Setup done${stamped ? ` (version ${VERSION})` : ''}. ${report.join('. ')}.`;
  console.log(summary);
  return summary;
}

/** Luxon needs the runtime's time zone data: make sure it's there. */
function checkTimeZones(): string {
  const utc = '2026-01-15T17:00:00.000Z';
  const toronto = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(utc));
  if (toronto !== '12') throw new Error(`Time zones don't work here (got ${toronto})`);
  return 'Time zones check out';
}

export { runHourlyJobs };

/**
 * Send queued emails and bring Google Calendars up to date (the page calls
 * this after a change; the 5-minute timer also does).
 */
export function sendQueuedEmails(): number {
  const sent = sendEmails();
  try {
    syncCalendars();
  } catch (err) {
    console.error(`Google Calendar: ${err instanceof Error ? err.message : String(err)}`);
  }
  return sent;
}
