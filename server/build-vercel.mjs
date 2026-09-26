// Packages the app for Vercel using the Build Output API
// (https://vercel.com/docs/build-output-api/v3). Run after `vite build`:
//   .vercel/output/static/            the web app, served by Vercel's CDN
//   .vercel/output/functions/api.func the whole /api as one Node.js function
//   .vercel/output/config.json        routing, headers and the daily cron
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import helmet from 'helmet';

const OUT = '.vercel/output';
const FUNC = `${OUT}/functions/api.func`;

// Same Node.js major version as package.json "engines" (e.g. "22.x").
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const nodeMajor = /\d+/.exec(pkg.engines?.node ?? '')?.[0];
if (!nodeMajor) throw new Error('package.json needs "engines": { "node": "22.x" }');

await rm(OUT, { recursive: true, force: true });
await cp('dist/web', `${OUT}/static`, { recursive: true });

await build({
  entryPoints: ['server/src/vercel.ts'],
  outfile: `${FUNC}/index.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: `node${nodeMajor}`,
  alias: { '@shared': './shared' },
  // Optional pg backends that are never used here.
  external: ['pg-native', 'cloudflare:sockets'],
  // Bundled CommonJS packages call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  legalComments: 'none',
  logLevel: 'info',
});
await cp('server/migrations', `${FUNC}/migrations`, { recursive: true });
await writeJson(`${FUNC}/.vc-config.json`, {
  runtime: `nodejs${nodeMajor}.x`,
  handler: 'index.mjs',
  launcherType: 'Nodejs',
  shouldAddHelpers: false,
  supportsResponseStreaming: true,
  // Emails are sent after the response; leave time for a batch.
  maxDuration: 60,
});

await writeJson(`${OUT}/config.json`, {
  version: 3,
  routes: [
    // Everything under /api goes to the function (it sets its own headers).
    { src: '^/api(?:/.*)?$', dest: '/api' },
    // The web app gets the security headers the Express server sends.
    { src: '^/.*$', headers: webSecurityHeaders(), continue: true },
    {
      src: '^/assets/.+$',
      headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
      continue: true,
    },
    { handle: 'filesystem' },
    // Client-side routes load the app; a missing asset stays a 404.
    { src: '^/(?!assets/).*$', dest: '/index.html' },
  ],
  // Reminders, email retries and cleanup (daily is the most the Hobby plan allows).
  crons: [{ path: '/api/cron', schedule: '0 14 * * *' }],
});
console.log(`Vercel output written to ${OUT}`);

/** The headers helmet adds in production (see server/src/app.ts). */
function webSecurityHeaders() {
  const headers = {};
  const res = {
    setHeader: (name, value) => (headers[name] = String(value)),
    removeHeader: () => undefined,
  };
  helmet({
    // Vercel only serves https, so there is nothing to upgrade (and this keeps
    // local http testing of the output working).
    contentSecurityPolicy: { useDefaults: true, directives: { 'upgrade-insecure-requests': null } },
    crossOriginEmbedderPolicy: false,
  })({}, res, (err) => {
    if (err) throw err;
  });
  return headers;
}

async function writeJson(file, data) {
  await mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}
