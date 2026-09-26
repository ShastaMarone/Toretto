import type { Config } from './config';
import type { Db } from './db';
import type { JobsReport } from './email/worker';
import type { Logger } from './logger';

export interface AppDeps {
  config: Config;
  db: Db;
  logger: Logger;
  /** Wake the background worker after queueing emails. */
  kick: () => void;
  /**
   * Run the scheduled jobs now (reminders, email retries, cleanup). Serves
   * GET /api/cron on serverless hosts, where no worker runs between requests.
   */
  runJobs?: () => Promise<JobsReport>;
}
