// Serves .vercel/output (from `npm run build:vercel`) the way Vercel does:
// the routes in config.json, static files, and the /api function with a
// waitUntil() request context. Lets the end-to-end test run against the exact
// bundle that gets deployed. A test tool only, not a production server.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const OUT = path.resolve('.vercel/output');
const STATIC = path.join(OUT, 'static');
const PORT = Number(process.env.PORT ?? 3000);

const { routes } = JSON.parse(await readFile(path.join(OUT, 'config.json'), 'utf8'));
const functions = new Map();
for (const name of ['api']) {
  const dir = path.join(OUT, 'functions', `${name}.func`);
  const vc = JSON.parse(await readFile(path.join(dir, '.vc-config.json'), 'utf8'));
  const mod = await import(pathToFileURL(path.join(dir, vc.handler)).href);
  functions.set(`/${name}`, mod.default);
}

// @vercel/functions looks up waitUntil() in this request context.
const requestContext = new AsyncLocalStorage();
globalThis[Symbol.for('@vercel/request-context')] = { get: () => requestContext.getStore() };
const pending = new Set();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

async function staticFile(pathname) {
  const file = path.join(STATIC, decodeURIComponent(pathname));
  if (!file.startsWith(STATIC + path.sep)) return null;
  const info = await stat(file).catch(() => null);
  return info?.isFile() ? file : null;
}

async function resolve(pathname) {
  if (functions.has(pathname)) return { fn: functions.get(pathname) };
  const file = await staticFile(pathname);
  return file ? { file } : null;
}

/** Apply config.json routes: returns the target plus the headers collected on the way. */
async function route(pathname) {
  const headers = {};
  for (const r of routes) {
    if (r.handle === 'filesystem') {
      const found = await resolve(pathname);
      if (found) return { ...found, headers };
      continue;
    }
    if (!new RegExp(r.src).test(pathname)) continue;
    Object.assign(headers, r.headers);
    if (r.dest) pathname = r.dest;
    if (!r.continue) return { ...(await resolve(pathname)), headers };
  }
  return { headers };
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const target = await route(pathname);
    if (target.fn) {
      // Vercel's proxy sets these; the function still sees the original URL.
      req.headers['x-forwarded-for'] = req.socket.remoteAddress ?? '127.0.0.1';
      req.headers['x-forwarded-proto'] = 'http';
      req.headers['x-forwarded-host'] = req.headers.host ?? `localhost:${PORT}`;
      const waitUntil = (promise) => {
        pending.add(promise);
        promise.finally(() => pending.delete(promise)).catch(() => undefined);
      };
      await requestContext.run({ waitUntil }, () => target.fn(req, res));
      return;
    }
    for (const [name, value] of Object.entries(target.headers)) res.setHeader(name, value);
    if (!target.file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404: NOT_FOUND');
      return;
    }
    res.setHeader('Content-Type', TYPES[path.extname(target.file)] ?? 'application/octet-stream');
    if (!res.hasHeader('Cache-Control'))
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(target.file).pipe(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500).end('500: INTERNAL_SERVER_ERROR');
  }
});

server.listen(PORT, () => console.log(`Vercel output served at http://localhost:${PORT}`));

async function shutdown() {
  server.close();
  await Promise.allSettled([...pending]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
