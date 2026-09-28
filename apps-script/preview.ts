// Try the Google Apps Script version on your own computer: the built files
// (apps-script/build/Code.gs and index.html, exactly what gets pasted into Apps
// Script) with an emulated Google Sheet, Gmail and demo data. Nothing is saved.
//
//   npm run build:apps-script && npm run preview:apps-script
//   → http://localhost:4400 (add ?as=priya@example.com to be someone else)
//   → http://localhost:4400/mail for the emails it would have sent (/mail.json for tests)
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { addDays, shiftTimesFromLocal, startOfWeek, todayIn } from '@shared/time';
import { activate, createEmulator, installAppsScript } from './test/emulator';

const PORT = Number(process.env.PORT ?? 4400);
const TZ = 'America/Toronto';
const ADMIN = 'alex@example.com';

const built = (file: string) =>
  readFileSync(fileURLToPath(new URL(`./build/${file}`, import.meta.url)), 'utf8');

const env = createEmulator();
activate(env);
env.owner = ADMIN;
env.appUrl = `http://localhost:${PORT}/exec`;
env.files.set('index', built('index.html'));
// Code.gs in a bare JavaScript sandbox with Apps Script's services, as in Google's.
const sandbox = vm.createContext({ console });
installAppsScript(sandbox);
vm.runInContext(built('Code.gs'), sandbox, { filename: 'Code.gs' });
const gas = sandbox as unknown as Record<string, (...args: unknown[]) => unknown> & {
  api(method: string, url: string, body: string | null): string;
  doGet(e: unknown): { getContent(): string };
};
gas.setup();

/** Call the API as someone, like the page does. */
function call(as: string, method: string, url: string, body?: unknown) {
  activate(env);
  env.activeUser = as;
  const res = JSON.parse(gas.api(method, url, body === undefined ? null : JSON.stringify(body)));
  if (res.status >= 400) throw new Error(`${method} ${url}: ${JSON.stringify(res.body)}`);
  return res.body;
}

// ---- Demo data -------------------------------------------------------------
call(ADMIN, 'PATCH', '/admin/settings', { orgName: 'Northwind Support' });
const tiers = call(ADMIN, 'GET', '/tiers') as { id: string; name: string }[];
const [tier1, tier2] = tiers;
const people = [
  ['Jordan Lee', 'jordan@example.com', tier1],
  ['Priya Patel', 'priya@example.com', tier1],
  ['Sam Chen', 'sam@example.com', tier1],
  ['Maria Garcia', 'maria@example.com', tier2],
  ['Taylor Kim', 'taylor@example.com', tier2],
  ['Riley Adams', 'riley@example.com', null],
] as const;
const ids: Record<string, string> = {};
for (const [name, email, tier] of people) {
  ids[email] = call(ADMIN, 'POST', '/users', { name, email, tierId: tier?.id ?? null }).id;
}
// Everyone but Riley has opened the app (joined).
for (const [, email] of people.slice(0, 5)) call(email, 'GET', '/bootstrap');
const mainSchedule = (call(ADMIN, 'GET', '/schedules') as { id: string }[])[0]!.id;
const monday = startOfWeek(todayIn(TZ), 1);
const shift = (email: string, dayOffset: number, start: string, end: string) =>
  call(ADMIN, 'POST', `/schedules/${mainSchedule}/shifts`, {
    userId: ids[email],
    ...shiftTimesFromLocal(addDays(monday, dayOffset), start, end, TZ),
  });
for (let d = 0; d < 12; d++) {
  if (d % 7 >= 5) continue;
  shift('jordan@example.com', d, '08:00', '16:00');
  shift('priya@example.com', d, '12:00', '20:00');
  shift('maria@example.com', d, '09:00', '17:00');
  if (d % 2 === 0) shift('sam@example.com', d, '16:00', '23:00');
}
call(ADMIN, 'POST', `/schedules/${mainSchedule}/publish`, {});
shift('taylor@example.com', 3, '10:00', '18:00'); // a draft
call('priya@example.com', 'POST', '/my/time-off', {
  typeId: (call(ADMIN, 'GET', '/time-off-types') as { id: string }[])[1]!.id,
  startDate: addDays(monday, 9),
  endDate: addDays(monday, 9),
  note: 'Dentist',
});
env.sent.length = 0;

// ---- The page and its API ------------------------------------------------------
const shim = (as: string) => `<script>
window.google = { script: {
  run: (function make(ok, fail) {
    return new Proxy({}, { get(_, fn) {
      if (fn === 'withSuccessHandler') return (h) => make(h, fail);
      if (fn === 'withFailureHandler') return (h) => make(ok, h);
      return (...args) => fetch('/rpc', { method: 'POST', body: JSON.stringify({ fn, args, as: ${JSON.stringify(as)} }) })
        .then((r) => r.json())
        .then((r) => (r.ok ? ok && ok(r.value) : fail && fail(new Error(r.error))))
        .catch((e) => fail && fail(e));
    } });
  })(null, null),
  history: {
    push(state, params) { const u = new URL(location.href); for (const k in params) u.searchParams.set(k, params[k]); history.pushState(state, '', u); },
    replace(state, params) { const u = new URL(location.href); for (const k in params) u.searchParams.set(k, params[k]); history.replaceState(state, '', u); },
    setChangeHandler(handler) { addEventListener('popstate', () => handler({ state: history.state, location: { parameter: Object.fromEntries(new URL(location.href).searchParams), hash: location.hash } })); },
  },
} };
</script>`;

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (req.method === 'POST' && url.pathname === '/rpc') {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const { fn, args, as } = JSON.parse(raw) as { fn: string; args: unknown[]; as: string };
      activate(env);
      env.activeUser = as;
      try {
        const run = gas[fn];
        if (typeof run !== 'function') throw new Error(`No function ${fn}`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, value: run(...args) }));
      } catch (err) {
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
    });
    return;
  }
  if (url.pathname === '/mail.json') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(env.sent));
    return;
  }
  if (url.pathname === '/mail') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      env.sent
        .map((m) => `<h3>To ${m.to}: ${m.subject}</h3>${m.htmlBody ?? `<pre>${m.body}</pre>`}<hr>`)
        .join('') || '<p>No emails sent yet.</p>',
    );
    return;
  }
  // The page, as doGet serves it (links in emails look like /exec/confirm-shift/<id>).
  const as = url.searchParams.get('as') ?? ADMIN;
  activate(env);
  env.activeUser = as;
  const params = Object.fromEntries(url.searchParams);
  delete params.as;
  const page = gas.doGet({
    pathInfo: url.pathname.replace(/^\/(exec\/?)?/, ''),
    queryString: new URLSearchParams(params).toString(),
    parameter: params,
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(page.getContent().replace('<head>', `<head>${shim(as)}`));
}).listen(PORT, () => {
  console.log(
    `Apps Script preview on http://localhost:${PORT} (as ${ADMIN}; add ?as=priya@example.com)`,
  );
});
