// Gives each end-to-end run an empty database (the server migrates it on start).
import pg from 'pg';

const url = new URL(process.env.DATABASE_URL);
const dbName = url.pathname.slice(1);
if (!/e2e/.test(dbName)) {
  console.error(`Refusing to reset "${dbName}": the e2e database name must contain "e2e".`);
  process.exit(1);
}
const maintenance = new URL(url);
maintenance.pathname = '/postgres';
const admin = new pg.Client({ connectionString: maintenance.toString() });
await admin.connect();
const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
if (!rowCount) await admin.query(`CREATE DATABASE "${dbName}"`);
await admin.end();

const db = new pg.Client({ connectionString: url.toString() });
await db.connect();
await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await db.end();
console.log(`Reset ${dbName}`);
