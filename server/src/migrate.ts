import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import type { Logger } from './logger';

// Arbitrary constant so concurrent app instances never migrate at the same time.
const MIGRATION_LOCK_ID = 7_104_216_311;

export function resolveMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(here, '../migrations'), // running from source (server/src)
    path.resolve(here, 'migrations'), // running the bundle (dist/server)
    path.resolve(process.cwd(), 'server/migrations'),
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((dir) => existsSync(dir));
  if (!found)
    throw new Error(`Could not find migrations directory (tried ${candidates.join(', ')})`);
  return found;
}

/** Apply pending .sql migrations in filename order. Returns the names applied. */
export async function migrate(
  pool: pg.Pool,
  options: { dir?: string; logger?: Logger } = {},
): Promise<string[]> {
  const dir = options.dir ?? resolveMigrationsDir();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file);
      options.logger?.info(`Applied migration ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return applied;
}
