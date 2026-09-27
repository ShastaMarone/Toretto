import pg from 'pg';

// DATE columns come back as 'YYYY-MM-DD' strings instead of JS Dates at local
// midnight (which silently shift across time zones).
pg.types.setTypeParser(1082, (value: string) => value);
// int8 (COUNT(*), SUM of ints) and numeric values in this app are small.
pg.types.setTypeParser(20, (value: string) => Number.parseInt(value, 10));
pg.types.setTypeParser(1700, (value: string) => Number.parseFloat(value));
// timestamptz values become ISO-8601 UTC strings, matching the API contract.
const parseTimestamptz = pg.types.getTypeParser(1184);
pg.types.setTypeParser(1184, (value: string) => (parseTimestamptz(value) as Date).toISOString());

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(
  connectionString: string,
  options: {
    searchPath?: string;
    max?: number;
    /** Give up connecting after this long (default: wait indefinitely). */
    connectionTimeoutMillis?: number;
    onError?: (err: Error) => void;
  } = {},
): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    options: options.searchPath ? `-c search_path=${options.searchPath}` : undefined,
  });
  // Errors on idle clients (e.g. the server restarted) must not crash the process.
  pool.on('error', (err) => options.onError?.(err));
  return pool;
}

/** Postgres broke a deadlock by rolling this transaction back. */
const DEADLOCK_DETECTED = '40P01';

/**
 * Run fn in a transaction. If Postgres picks it to break a deadlock, it runs
 * once more: everything it did was rolled back, and the other side has gone.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (attempt === 1 && (err as { code?: string }).code === DEADLOCK_DETECTED) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
