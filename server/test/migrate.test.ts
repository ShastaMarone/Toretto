import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPool } from '../src/db';
import { migrate } from '../src/migrate';
import { TEST_DB_URL } from './helpers';

describe('migrations', () => {
  it('are applied once, even when several instances start at the same time', async () => {
    const schema = `test_${randomBytes(6).toString('hex')}`;
    const root = createPool(TEST_DB_URL, { max: 1 });
    await root.query(`CREATE SCHEMA ${schema}`);
    const db = createPool(TEST_DB_URL, { searchPath: schema, max: 4 });
    try {
      const results = await Promise.all([migrate(db), migrate(db), migrate(db)]);
      expect(results.flat()).toEqual([
        '001_initial.sql',
        '002_continuous_schedules.sql',
        '003_time_format.sql',
        '004_calendar_feed.sql',
        '005_email_retention.sql',
        '006_partial_time_off.sql',
        '007_overtime.sql',
        '008_shift_swaps.sql',
      ]);
      // Exactly one instance did the work.
      expect(results.filter((r) => r.length > 0)).toHaveLength(1);
      expect(await migrate(db)).toEqual([]);
      const { rows } = await db.query('SELECT name FROM schema_migrations ORDER BY name');
      expect(rows.map((r) => r.name)).toEqual([
        '001_initial.sql',
        '002_continuous_schedules.sql',
        '003_time_format.sql',
        '004_calendar_feed.sql',
        '005_email_retention.sql',
        '006_partial_time_off.sql',
        '007_overtime.sql',
        '008_shift_swaps.sql',
      ]);
    } finally {
      await db.end();
      await root.query(`DROP SCHEMA ${schema} CASCADE`);
      await root.end();
    }
  });
});
