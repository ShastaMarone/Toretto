import type { Config } from './config';
import type { Db } from './db';
import type { Logger } from './logger';

export interface AppDeps {
  config: Config;
  db: Db;
  logger: Logger;
  /** Wake the background worker after queueing emails. */
  kick: () => void;
}
