import type { Queryable } from '../db';
import { hashToken, randomToken } from './crypto';

export type TokenPurpose = 'verify_email' | 'invite' | 'reset_password' | 'magic_link';

/** How long each kind of emailed link stays valid. */
export const TOKEN_TTL_MINUTES: Record<TokenPurpose, number> = {
  verify_email: 48 * 60,
  invite: 7 * 24 * 60,
  reset_password: 60,
  magic_link: 20,
};

/** Create a single-use token, invalidating older unused ones for the same purpose. */
export async function issueToken(
  db: Queryable,
  userId: string,
  purpose: TokenPurpose,
): Promise<string> {
  const token = randomToken();
  await db.query(
    `UPDATE auth_tokens SET used_at = now()
      WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
    [userId, purpose],
  );
  await db.query(
    `INSERT INTO auth_tokens (id, user_id, purpose, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [hashToken(token), userId, purpose, TOKEN_TTL_MINUTES[purpose]],
  );
  return token;
}

export interface TokenMatch {
  userId: string;
  purpose: TokenPurpose;
}

/** Look up a valid token without using it up. */
export async function peekToken(
  db: Queryable,
  token: string,
  purposes: TokenPurpose[],
): Promise<TokenMatch | null> {
  const { rows } = await db.query<TokenMatch>(
    `SELECT user_id AS "userId", purpose FROM auth_tokens
      WHERE id = $1 AND purpose = ANY($2) AND used_at IS NULL AND expires_at > now()`,
    [hashToken(token), purposes],
  );
  return rows[0] ?? null;
}

/** Atomically mark a valid token as used. Returns null if invalid, expired or already used. */
export async function consumeToken(
  db: Queryable,
  token: string,
  purposes: TokenPurpose[],
): Promise<TokenMatch | null> {
  const { rows } = await db.query<TokenMatch>(
    `UPDATE auth_tokens SET used_at = now()
      WHERE id = $1 AND purpose = ANY($2) AND used_at IS NULL AND expires_at > now()
      RETURNING user_id AS "userId", purpose`,
    [hashToken(token), purposes],
  );
  return rows[0] ?? null;
}
