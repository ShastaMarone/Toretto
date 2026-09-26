import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
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
if (config.runWorker) worker.start();
// With a separate worker process, wake it through Postgres LISTEN/NOTIFY.
const kick = config.runWorker
  ? () => worker.kick()
  : () => void db.query(`NOTIFY ${OUTBOX_CHANNEL}`).catch(() => undefined);

const here = path.dirname(fileURLToPath(import.meta.url));
const staticDir = config.staticDir ?? path.resolve(here, '../web');
const app = createApp({ config: { ...config, staticDir }, db, logger, kick });

const server = app.listen(config.port, () => {
  logger.info(`Toretto listening on port ${config.port} — open ${config.appUrl}`);
  if (config.devMailbox)
    logger.info(`Dev mailbox (all outgoing email): ${config.appUrl}/dev/mailbox`);
  if (config.isProduction && config.email.transport === 'console') {
    logger.warn(
      'EMAIL_TRANSPORT=console in production: emails are only written to this log. Configure SMTP, Postmark or SendGrid.',
    );
  }
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down`);
  server.close();
  await worker.stop();
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
