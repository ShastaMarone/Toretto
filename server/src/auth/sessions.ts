import type { Response } from 'express';
import type { Config } from '../config';
import type { Queryable } from '../db';
import { hashToken, randomToken } from './crypto';
import { AUTH_USER_COLUMNS, type AuthUser } from './types';

export const SESSION_COOKIE = 'toretto_session';
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

export async function createSession(
  db: Queryable,
  userId: string,
  userAgent?: string,
): Promise<{ token: string; sessionId: string }> {
  const token = randomToken();
  const sessionId = hashToken(token);
  await db.query(
    `INSERT INTO sessions (id, user_id, expires_at, user_agent)
     VALUES ($1, $2, now() + make_interval(days => $3), $4)`,
    [sessionId, userId, SESSION_DAYS, userAgent?.slice(0, 300) ?? null],
  );
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  return { token, sessionId };
}

/**
 * Resolve a session cookie to its user. Sessions slide: at most once an hour
 * the expiry is pushed out again, and `refreshed` tells the caller to re-send
 * the cookie so the browser's copy slides too.
 */
export async function resolveSession(
  db: Queryable,
  token: string,
): Promise<{ user: AuthUser; sessionId: string; refreshed: boolean } | null> {
  const sessionId = hashToken(token);
  const { rows } = await db.query<AuthUser & { stale: boolean }>(
    `SELECT ${AUTH_USER_COLUMNS}, (s.last_seen_at < now() - interval '1 hour') AS stale
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1
        AND s.expires_at > now()
        AND u.deactivated_at IS NULL
        AND u.email_verified_at IS NOT NULL`,
    [sessionId],
  );
  const row = rows[0];
  if (!row) return null;
  const { stale, ...user } = row;
  if (stale) {
    await db.query(
      `UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(days => $2)
        WHERE id = $1`,
      [sessionId, SESSION_DAYS],
    );
  }
  return { user, sessionId, refreshed: stale };
}

export async function destroySession(db: Queryable, sessionId: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

export async function destroyUserSessions(
  db: Queryable,
  userId: string,
  exceptSessionId?: string,
): Promise<void> {
  await db.query('DELETE FROM sessions WHERE user_id = $1 AND id IS DISTINCT FROM $2', [
    userId,
    exceptSessionId ?? null,
  ]);
}

export function setSessionCookie(res: Response, token: string, config: Config): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax',
    maxAge: SESSION_MS,
    path: '/',
  });
}

export function clearSessionCookie(res: Response, config: Config): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax',
    path: '/',
  });
}
