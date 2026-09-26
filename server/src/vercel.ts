// Vercel entry point. `npm run build:vercel` bundles this into the single
// serverless function behind /api/*; the web app itself is served by Vercel's
// CDN. No worker runs between requests, so emails are sent right after the
// request that queued them, and reminders and retries run on later requests
// and on a daily Vercel Cron call to /api/cron.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { attachDatabasePool, waitUntil } from '@vercel/functions';
import { createApp } from './app';
import { loadConfig, type Config } from './config';
import { createPool } from './db';
import { createMailer } from './email/transport';
import { createJobs } from './email/worker';
import { createLogger } from './logger';
import { migrate } from './migrate';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** A warm instance runs the periodic jobs at most this often. */
const JOBS_EVERY_MS = 60_000;
/** Stop starting new email batches after this long, well inside the function's time limit. */
const SEND_BUDGET_MS = 30_000;

class NotConfiguredError extends Error {}

let ready: Promise<Handler> | null = null;

async function init(): Promise<Handler> {
  // Vercel sets NODE_ENV=production for functions; make sure of it.
  process.env.NODE_ENV ??= 'production';
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    throw new NotConfiguredError((err as Error).message);
  }
  const logger = createLogger(config.logLevel);
  const db = createPool(config.databaseUrl, {
    max: 5,
    connectionTimeoutMillis: 15_000,
    onError: (err) => logger.error('Postgres idle client error', err),
  });
  // Close idle connections before the instance is suspended.
  attachDatabasePool(db);
  try {
    await migrate(db, { logger });
  } catch (err) {
    await db.end().catch(() => undefined);
    throw err;
  }
  if (config.email.transport === 'console' && !config.devMailbox) {
    logger.warn(
      'EMAIL_TRANSPORT=console: emails are only written to this log. Configure SMTP, Postmark or SendGrid.',
    );
  }

  const jobs = createJobs({
    db,
    mailer: createMailer(config, logger),
    logger,
    config,
    budgetMs: SEND_BUDGET_MS,
  });
  // Keep the function alive after responding until the work is done.
  const inBackground = (work: Promise<unknown>) =>
    waitUntil(work.catch((err) => logger.error('Background job failed', err)));
  const app = createApp({
    config,
    db,
    logger,
    kick: () => inBackground(jobs.drainOutbox()),
    runJobs: () => jobs.runDue({ force: true }),
  });

  let lastJobs = 0;
  return (req, res) => {
    const now = Date.now();
    if (now - lastJobs >= JOBS_EVERY_MS) {
      lastJobs = now;
      inBackground(jobs.runDue());
    }
    app(req, res);
  };
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const starting = (ready ??= init());
  let handle: Handler;
  try {
    handle = await starting;
  } catch (err) {
    if (ready === starting) ready = null; // try again on the next request
    console.error('Toretto could not start:', err);
    const body =
      err instanceof NotConfiguredError
        ? { code: 'NOT_CONFIGURED', message: `The server is missing settings. ${err.message}` }
        : {
            code: 'UNAVAILABLE',
            message:
              "The server couldn't connect to its database. Check DATABASE_URL in the Vercel project settings; details are in the function logs.",
          };
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: body }));
    return;
  }
  handle(req, res);
}
