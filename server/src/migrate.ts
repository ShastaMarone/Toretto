import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { withTransaction } from './db';
import type { Logger } from './logger';

// Arbitrary constant so concurrent app instances never migrate at the same time.
const MIGRATION_LOCK_ID = 7_104_216_311;

export function resolveMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(here, '../migrations'), // running from source (server/src)
    path.resolve(here, 'migrations'), // running a bundle (dist/server, the Vercel function)
    path.resolve(process.cwd(), 'server/migrations'),
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((dir) => existsSync(dir));
  if (!found)
    throw new Error(`Could not find migrations directory (tried ${candidates.join(', ')})`);
  return found;
}

/**
 * Apply pending .sql migrations in filename order, all in one transaction.
 * Returns the names applied. The lock is transaction-scoped, so this also
 * works through a transaction-mode connection pooler (PgBouncer, Neon).
 */
export async function migrate(
  pool: pg.Pool,
  options: { dir?: string; logger?: Logger } = {},
): Promise<string[]> {
  const dir = options.dir ?? resolveMigrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = await withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    const ran: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      try {
        await client.query(sql);
      } catch (err) {
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      ran.push(file);
    }
    return ran;
  });
  for (const file of applied) options.logger?.info(`Applied migration ${file}`);
  return applied;
}
