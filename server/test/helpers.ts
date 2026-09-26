import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import type pg from 'pg';
import request from 'supertest';
import { addDays, shiftTimesFromLocal, startOfWeek, todayIn } from '@shared/time';
import { createApp } from '../src/app';
import { hashPassword } from '../src/auth/crypto';
import { loadConfig, type Config } from '../src/config';
import { createPool } from '../src/db';
import { createLogger } from '../src/logger';
import { migrate } from '../src/migrate';

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://toretto:toretto@localhost:5432/toretto_test';
export const APP_URL = 'http://localhost:5173';
export const PASSWORD = 'password123';
export const TZ = 'America/Toronto';

export type Agent = ReturnType<typeof request.agent>;

export interface TestContext {
  db: pg.Pool;
  app: Express;
  config: Config;
  /** How many times routes asked the worker to wake up. */
  kicks: () => number;
  agent(): Agent;
  close(): Promise<void>;
}

/** Fresh app + isolated Postgres schema per test file. */
export async function createTestContext(env: Record<string, string> = {}): Promise<TestContext> {
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const root = createPool(TEST_DB_URL, { max: 1 });
  await root.query(`CREATE SCHEMA ${schema}`);
  await root.end();
  const db = createPool(TEST_DB_URL, { searchPath: schema, max: 5 });
  await migrate(db);
  await db.query('UPDATE org_settings SET timezone = $1', [TZ]);
  const config = loadConfig({ NODE_ENV: 'test', APP_URL, DATABASE_URL: TEST_DB_URL, ...env });
  let kicks = 0;
  const app = createApp({ config, db, logger: createLogger('silent'), kick: () => void kicks++ });
  return {
    db,
    app,
    config,
    kicks: () => kicks,
    agent: () => request.agent(app),
    async close() {
      await db.end();
      const cleanup = createPool(TEST_DB_URL, { max: 1 });
      await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);
      await cleanup.end();
    },
  };
}

let passwordHash: Promise<string> | null = null;

export async function createUser(
  db: pg.Pool,
  input: {
    name: string;
    email?: string;
    role?: 'admin' | 'member';
    tierId?: string | null;
    teamId?: string | null;
    verified?: boolean;
    withPassword?: boolean;
    timezone?: string | null;
  },
): Promise<{ id: string; name: string; email: string }> {
  passwordHash ??= hashPassword(PASSWORD);
  const email = input.email ?? `${input.name.toLowerCase().replace(/\W+/g, '.')}@example.com`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, role, tier_id, team_id, email_verified_at, timezone)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN now() END, $8) RETURNING id`,
    [
      input.name,
      email,
      input.withPassword === false ? null : await passwordHash,
      input.role ?? 'member',
      input.tierId ?? null,
      input.teamId ?? null,
      input.verified ?? true,
      input.timezone ?? null,
    ],
  );
  return { id: rows[0]!.id, name: input.name, email };
}

export async function login(agent: Agent, email: string, password = PASSWORD) {
  const res = await agent.post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status} ${res.text}`);
  return res.body.user as { id: string };
}

export async function createTier(db: pg.Pool, name: string, color = '#4f46e5'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO tiers (name, color) VALUES ($1, $2) RETURNING id',
    [name, color],
  );
  return rows[0]!.id;
}

export async function createLabel(
  db: pg.Pool,
  name: string,
  tierId: string | null,
  color = '#dc2626',
) {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO labels (tier_id, name, color) VALUES ($1, $2, $3) RETURNING id',
    [tierId, name, color],
  );
  return rows[0]!.id;
}

/** Monday of next week in the test time zone (so shifts are in the future). */
export function nextMonday(): string {
  return addDays(startOfWeek(todayIn(TZ), 1), 7);
}

export function shiftOn(date: string, start = '09:00', end = '17:00') {
  return shiftTimesFromLocal(date, start, end, TZ);
}

export interface Email {
  kind: string;
  toEmail: string;
  subject: string;
  html: string;
  text: string;
  scheduleId: string | null;
  shiftIds: string[];
}

export async function emails(
  db: pg.Pool,
  filter: { to?: string; kind?: string } = {},
): Promise<Email[]> {
  const { rows } = await db.query<Email>(
    `SELECT kind, to_email AS "toEmail", subject, html, text, schedule_id AS "scheduleId",
            shift_ids AS "shiftIds"
       FROM notifications
      WHERE ($1::text IS NULL OR to_email = $1) AND ($2::text IS NULL OR kind = $2)
      ORDER BY created_at, id`,
    [filter.to ?? null, filter.kind ?? null],
  );
  return rows;
}

export async function clearEmails(db: pg.Pool) {
  await db.query('DELETE FROM notifications');
}

/** Pull the first link to `path` out of an email's text, e.g. linkIn(email, '/verify-email'). */
export function linkIn(email: Email, path: string): string {
  const match = new RegExp(`${APP_URL.replace('.', '\\.')}${path}[^\\s]*`).exec(email.text);
  if (!match) throw new Error(`No ${path} link in email "${email.subject}":\n${email.text}`);
  return match[0];
}

export function tokenIn(email: Email, path: string): string {
  return new URL(linkIn(email, path)).searchParams.get('token')!;
}
