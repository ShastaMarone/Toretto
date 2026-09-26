import type { SessionUser } from '@shared/types';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDummyHash, hashPassword, verifyPassword } from '../auth/crypto';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  destroyUserSessions,
  setSessionCookie,
} from '../auth/sessions';
import { consumeToken, peekToken, type TokenPurpose } from '../auth/tokens';
import { AUTH_USER_COLUMNS, type AuthUser } from '../auth/types';
import { withTransaction, type Queryable } from '../db';
import type { AppDeps } from '../deps';
import { safeNextPath, sendAccountEmail } from '../email/account';
import { enqueueEmail } from '../email/outbox';
import { accountExistsTemplate } from '../email/templates';
import { conflict, forbidden, HttpError, notFound } from '../errors';
import { limiter } from '../lib/rateLimit';
import { parse, zEmail, zName, zPassword, zTimezone } from '../lib/validation';
import { audit } from '../services/audit';
import { seedDefaults } from '../services/defaults';
import { getSettings } from '../services/settings';

const TokenBody = z.object({ token: z.string().min(10).max(200) });

/** Emailed links that let someone choose a password (and so confirm their address). */
const PASSWORD_LINKS: TokenPurpose[] = ['invite', 'verify_email', 'reset_password'];

const invalidLink = (message: string) => new HttpError(400, 'INVALID_TOKEN', message);

export function toSessionUser(user: AuthUser): SessionUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    tierId: user.tierId,
    teamId: user.teamId,
    timezone: user.timezone,
    hasPassword: user.hasPassword,
    notifyTimeOff: user.notifyTimeOff,
    notifyConfirmations: user.notifyConfirmations,
  };
}

export async function loadAuthUser(db: Queryable, id: string): Promise<AuthUser> {
  const { rows } = await db.query<AuthUser>(
    `SELECT ${AUTH_USER_COLUMNS} FROM users u WHERE u.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('Person');
  return rows[0];
}

export async function hasAnyUsers(db: Queryable): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM users LIMIT 1');
  return rows.length > 0;
}

export function authRoutes({ db, config, kick }: AppDeps): Router {
  const r = Router();

  async function startSession(req: Request, res: Response, userId: string) {
    if (req.sessionId) await destroySession(db, req.sessionId);
    const { token } = await createSession(db, userId, req.get('user-agent'));
    setSessionCookie(res, token, config);
    const user = await loadAuthUser(db, userId);
    res.json({ user: toSessionUser(user) });
  }

  // First-run: create the organization and its first admin.
  r.post('/setup', limiter(config, 10), async (req, res) => {
    const body = parse(
      z.object({
        name: zName('Your name', 100),
        email: zEmail,
        orgName: zName('Organization name', 80),
        timezone: zTimezone,
      }),
      req.body,
    );
    if (config.adminEmail && body.email !== config.adminEmail) {
      throw forbidden(
        "This email address isn't allowed to set up this workspace. Use the address configured as ADMIN_EMAIL.",
        'SETUP_EMAIL_MISMATCH',
      );
    }
    if (!config.adminEmail && !config.openSetup) {
      throw forbidden(
        'First-time setup is locked. Set the ADMIN_EMAIL environment variable to the email of the first admin.',
        'SETUP_LOCKED',
      );
    }
    // No password yet: the admin chooses one from the emailed link, which proves
    // they own the address (a password typed here could belong to anyone).
    const email = await withTransaction(db, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['toretto:setup']);
      if (await hasAnyUsers(client)) {
        throw conflict('Setup is already complete. Please sign in.', 'SETUP_COMPLETE');
      }
      await client.query('UPDATE org_settings SET org_name = $1, timezone = $2', [
        body.orgName,
        body.timezone,
      ]);
      const { rows } = await client.query<{ id: string; name: string; email: string }>(
        `INSERT INTO users (name, email, role)
         VALUES ($1, $2, 'admin') RETURNING id, name, email`,
        [body.name, body.email],
      );
      const admin = rows[0]!;
      await seedDefaults(client);
      await sendAccountEmail(client, config, admin, 'verify_email');
      await audit(client, admin.id, 'org.setup', { type: 'org' }, { orgName: body.orgName });
      return admin.email;
    });
    kick();
    res.status(201).json({ ok: true, email });
  });

  r.post('/signup', limiter(config, 10), async (req, res) => {
    const body = parse(z.object({ name: zName('Name', 100), email: zEmail }), req.body);
    if (!(await hasAnyUsers(db))) {
      throw conflict('This workspace has not been set up yet.', 'SETUP_REQUIRED');
    }
    const settings = await getSettings(db);
    if (!settings.selfSignup) {
      throw forbidden('Sign-up is turned off. Ask your admin to invite you.', 'SIGNUP_DISABLED');
    }
    const domain = body.email.split('@')[1] ?? '';
    if (settings.allowedDomains.length && !settings.allowedDomains.includes(domain)) {
      throw forbidden(
        `Sign-up is limited to ${settings.allowedDomains.map((d) => `@${d}`).join(', ')} email addresses.`,
        'DOMAIN_NOT_ALLOWED',
      );
    }
    await withTransaction(db, async (client) => {
      const { rows: existing } = await client.query<{
        id: string;
        name: string;
        email: string;
        active: boolean;
      }>('SELECT id, name, email, (deactivated_at IS NULL) AS active FROM users WHERE email = $1', [
        body.email,
      ]);
      const found = existing[0];
      if (found) {
        // Don't reveal that the account exists; tell the owner by email instead.
        if (found.active) {
          await enqueueEmail(client, {
            userId: found.id,
            to: found.email,
            kind: 'account_exists',
            email: accountExistsTemplate(
              { orgName: settings.orgName, appUrl: config.appUrl },
              {
                name: found.name,
                signInUrl: `${config.appUrl}/login`,
                resetUrl: `${config.appUrl}/forgot-password`,
              },
            ),
          });
        }
        return;
      }
      const { rows } = await client.query<{ id: string; name: string; email: string }>(
        `INSERT INTO users (name, email, role)
         VALUES ($1, $2, 'member') RETURNING id, name, email`,
        [body.name, body.email],
      );
      const user = rows[0]!;
      await sendAccountEmail(client, config, user, 'verify_email');
      await audit(
        client,
        user.id,
        'user.signed_up',
        { type: 'user', id: user.id },
        { name: user.name },
      );
    });
    kick();
    res.status(202).json({ ok: true });
  });

  r.post('/login', limiter(config, 30), async (req, res) => {
    const body = parse(
      z.object({ email: zEmail, password: z.string().min(1, 'Password is required').max(200) }),
      req.body,
    );
    const { rows } = await db.query<{
      id: string;
      passwordHash: string | null;
      verified: boolean;
      active: boolean;
    }>(
      `SELECT id, password_hash AS "passwordHash", (email_verified_at IS NOT NULL) AS verified,
              (deactivated_at IS NULL) AS active
         FROM users WHERE email = $1`,
      [body.email],
    );
    const user = rows[0];
    let valid = false;
    if (user?.passwordHash) valid = await verifyPassword(body.password, user.passwordHash);
    else await verifyPassword(body.password, await getDummyHash());
    if (!user || !valid) {
      throw new HttpError(
        401,
        'INVALID_CREDENTIALS',
        "That email and password don't match. If you haven't set a password yet, use “Email me a sign-in link”.",
      );
    }
    if (!user.active) {
      throw forbidden(
        'Your account has been deactivated. Contact your admin.',
        'ACCOUNT_DEACTIVATED',
      );
    }
    if (!user.verified) {
      throw forbidden(
        'Please confirm your email first — check your inbox for the confirmation link.',
        'EMAIL_NOT_VERIFIED',
      );
    }
    await startSession(req, res, user.id);
  });

  r.post('/logout', async (req, res) => {
    if (req.sessionId) await destroySession(db, req.sessionId);
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  r.post('/resend-verification', limiter(config, 10), async (req, res) => {
    const { email } = parse(z.object({ email: zEmail }), req.body);
    const { rows } = await db.query<{ id: string; name: string; email: string }>(
      `SELECT id, name, email FROM users
        WHERE email = $1 AND email_verified_at IS NULL AND deactivated_at IS NULL`,
      [email],
    );
    if (rows[0]) {
      await sendAccountEmail(db, config, rows[0], 'verify_email');
      kick();
    }
    res.status(202).json({ ok: true });
  });

  r.post('/magic-link', limiter(config, 10), async (req, res) => {
    const { email, next } = parse(
      z.object({ email: zEmail, next: z.string().max(300).optional() }),
      req.body,
    );
    const { rows } = await db.query<{ id: string; name: string; email: string }>(
      'SELECT id, name, email FROM users WHERE email = $1 AND deactivated_at IS NULL',
      [email],
    );
    if (rows[0]) {
      await sendAccountEmail(db, config, rows[0], 'magic_link', { next: safeNextPath(next) });
      kick();
    }
    res.status(202).json({ ok: true });
  });

  r.post('/magic-link/verify', limiter(config, 30), async (req, res) => {
    const { token } = parse(TokenBody, req.body);
    const userId = await withTransaction(db, async (client) => {
      const match = await consumeToken(client, token, ['magic_link']);
      if (!match)
        throw invalidLink('This sign-in link is invalid or has expired. Request a new one.');
      // Clicking a link sent to the address proves the person owns it. A
      // password set before the address was confirmed can't be trusted.
      const { rows } = await client.query<{ id: string }>(
        `UPDATE users
            SET password_hash = CASE WHEN email_verified_at IS NULL THEN NULL ELSE password_hash END,
                email_verified_at = COALESCE(email_verified_at, now())
          WHERE id = $1 AND deactivated_at IS NULL RETURNING id`,
        [match.userId],
      );
      if (!rows[0]) throw forbidden('This account has been deactivated.', 'ACCOUNT_DEACTIVATED');
      return match.userId;
    });
    await startSession(req, res, userId);
  });

  r.post('/forgot-password', limiter(config, 10), async (req, res) => {
    const { email } = parse(z.object({ email: zEmail }), req.body);
    const { rows } = await db.query<{ id: string; name: string; email: string }>(
      'SELECT id, name, email FROM users WHERE email = $1 AND deactivated_at IS NULL',
      [email],
    );
    if (rows[0]) {
      await sendAccountEmail(db, config, rows[0], 'reset_password');
      kick();
    }
    res.status(202).json({ ok: true });
  });

  // Lets the set-password page greet the person before they submit.
  r.post('/token-info', limiter(config, 60), async (req, res) => {
    const { token } = parse(TokenBody, req.body);
    const match = await peekToken(db, token, PASSWORD_LINKS);
    const { rows } = match
      ? await db.query<{ name: string; email: string }>(
          'SELECT name, email FROM users WHERE id = $1 AND deactivated_at IS NULL',
          [match.userId],
        )
      : { rows: [] };
    if (!match || !rows[0])
      throw invalidLink('This link is invalid or has expired. Ask for a new one.');
    res.json({ purpose: match.purpose, name: rows[0].name, email: rows[0].email });
  });

  // Accept an invite, confirm a new account, or finish a password reset.
  r.post('/set-password', limiter(config, 30), async (req, res) => {
    const { token, password } = parse(TokenBody.extend({ password: zPassword }), req.body);
    const passwordHash = await hashPassword(password);
    const userId = await withTransaction(db, async (client) => {
      const match = await consumeToken(client, token, PASSWORD_LINKS);
      if (!match) throw invalidLink('This link is invalid or has expired. Ask for a new one.');
      const { rows } = await client.query<{ id: string }>(
        `UPDATE users SET password_hash = $2, email_verified_at = COALESCE(email_verified_at, now())
          WHERE id = $1 AND deactivated_at IS NULL RETURNING id`,
        [match.userId, passwordHash],
      );
      if (!rows[0]) throw invalidLink('This link is invalid or has expired. Ask for a new one.');
      // A new password signs out every other device.
      await destroyUserSessions(client, match.userId);
      const action = {
        invite: 'user.invite_accepted',
        verify_email: 'user.email_verified',
        reset_password: 'user.password_reset',
        magic_link: 'user.password_reset',
      }[match.purpose];
      await audit(client, match.userId, action, { type: 'user', id: match.userId });
      return match.userId;
    });
    await startSession(req, res, userId);
  });

  return r;
}
