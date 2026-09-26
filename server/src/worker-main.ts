// Standalone background worker: `npm run worker` (with RUN_WORKER=false on the web process).
import { loadConfig, loadDotEnv } from './config';
import { createPool } from './db';
import { createMailer } from './email/transport';
import { createWorker, OUTBOX_CHANNEL } from './email/worker';
import { createLogger } from './logger';
import { migrate } from './migrate';

loadDotEnv();
const config = loadConfig();
const logger = createLogger(config.logLevel);
const db = createPool(config.databaseUrl, {
  onError: (err) => logger.error('Postgres idle client error', err),
});
await migrate(db, { logger });

const worker = createWorker({ db, mailer: createMailer(config, logger), logger, config });
worker.start();

const listener = await db.connect();
listener.on('notification', () => worker.kick());
await listener.query(`LISTEN ${OUTBOX_CHANNEL}`);

async function shutdown() {
  await worker.stop();
  listener.release();
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
