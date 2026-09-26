// Apply pending database migrations: `npm run migrate` (the server also does this on start).
import { loadConfig, loadDotEnv } from '../src/config';
import { createPool } from '../src/db';
import { createLogger } from '../src/logger';
import { migrate } from '../src/migrate';

loadDotEnv();
const config = loadConfig();
const db = createPool(config.databaseUrl);
const applied = await migrate(db, { logger: createLogger('info') });
console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
await db.end();
