import type { Person, Role } from '@shared/types';
import { Router } from 'express';
import { z } from 'zod';
import { destroyUserSessions } from '../auth/sessions';
import { withTransaction, type Queryable } from '../db';
import type { AppDeps } from '../deps';
import { sendAccountEmail } from '../email/account';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { parse, zEmail, zId, zIdParam, zName, zTimezone } from '../lib/validation';
import { audit } from '../services/audit';

const PERSON_SQL = `
  SELECT u.id, u.name, u.email, u.role, u.tier_id AS "tierId", u.team_id AS "teamId", u.timezone,
         CASE WHEN u.deactivated_at IS NOT NULL THEN 'deactivated'
              WHEN u.email_verified_at IS NULL THEN 'invited'
              ELSE 'active' END AS status,
         u.last_login_at AS "lastLoginAt", u.created_at AS "createdAt",
         (SELECT count(*)::int FROM shifts s WHERE s.user_id = u.id AND s.deleted_at IS NULL) AS "shiftCount"
    FROM users u`;

async function getPerson(db: Queryable, id: string): Promise<Person> {
  const { rows } = await db.query<Person>(`${PERSON_SQL} WHERE u.id = $1`, [id]);
  if (!rows[0]) throw notFound('Person');
  return rows[0];
}

async function assertRefs(db: Queryable, tierId?: string | null, teamId?: string | null) {
  if (tierId) {
    const { rows } = await db.query('SELECT 1 FROM tiers WHERE id = $1', [tierId]);
    if (!rows.length) throw notFound('Tier');
  }
  if (teamId) {
    const { rows } = await db.query('SELECT 1 FROM teams WHERE id = $1', [teamId]);
    if (!rows.length) throw notFound('Team');
  }
}

/**
 * Serialize changes to people (roles, deactivation, deletion) so two admins
 * demoting each other at once can't both pass the last-admin check.
 */
async function lockAdminChanges(db: Queryable) {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['toretto:people']);
}

/** Refuse changes that would leave the organization without an active admin. */
async function assertOtherAdmin(db: Queryable, userId: string) {
  const { rows } = await db.query(
    `SELECT 1 FROM users
      WHERE role = 'admin' AND deactivated_at IS NULL AND email_verified_at IS NOT NULL AND id <> $1
      LIMIT 1`,
    [userId],
  );
  if (!rows.length) {
    throw conflict(
      'There must always be at least one active admin who has signed in.',
      'LAST_ADMIN',
    );
  }
}

export function userRoutes({ db, config, kick }: AppDeps): Router {
  const r = Router();

  r.get('/', async (_req, res) => {
    const { rows } = await db.query<Person>(
      `${PERSON_SQL} ORDER BY (u.deactivated_at IS NOT NULL), lower(u.name)`,
    );
    res.json(rows);
  });

  // Invite someone: creates their account and emails a link to set a password.
  r.post('/', async (req, res) => {
    const body = parse(
      z.object({
        name: zName('Name', 100),
        email: zEmail,
        role: z.enum(['admin', 'member']).default('member'),
        tierId: zId.nullable().default(null),
        teamId: zId.nullable().default(null),
      }),
      req.body,
    );
    const admin = req.user!;
    const id = await withTransaction(db, async (client) => {
      await assertRefs(client, body.tierId, body.teamId);
      const { rows: existing } = await client.query('SELECT 1 FROM users WHERE email = $1', [
        body.email,
      ]);
      if (existing.length) {
        throw conflict('Someone with this email address is already on the team.', 'EMAIL_TAKEN');
      }
      const { rows } = await client.query<{ id: string; name: string; email: string }>(
        `INSERT INTO users (name, email, role, tier_id, team_id, invited_at, invited_by)
         VALUES ($1, $2, $3, $4, $5, now(), $6) RETURNING id, name, email`,
        [body.name, body.email, body.role, body.tierId, body.teamId, admin.id],
      );
      const user = rows[0]!;
      await sendAccountEmail(client, config, user, 'invite', { inviterName: admin.name });
      await audit(
        client,
        admin.id,
        'user.invited',
        { type: 'user', id: user.id },
        {
          name: user.name,
          email: user.email,
          role: body.role,
        },
      );
      return user.id;
    });
    kick();
    res.status(201).json(await getPerson(db, id));
  });

  r.patch('/:id', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const body = parse(
      z.object({
        name: zName('Name', 100).optional(),
        email: zEmail.optional(),
        role: z.enum(['admin', 'member']).optional(),
        tierId: zId.nullable().optional(),
        teamId: zId.nullable().optional(),
        timezone: zTimezone.nullable().optional(),
        active: z.boolean().optional(),
      }),
      req.body,
    );
    const admin = req.user!;
    const resendInvite = await withTransaction(db, async (client) => {
      await lockAdminChanges(client);
      const { rows } = await client.query<{
        name: string;
        email: string;
        role: Role;
        verified: boolean;
        active: boolean;
      }>(
        `SELECT name, email, role, (email_verified_at IS NOT NULL) AS verified,
                (deactivated_at IS NULL) AS active
           FROM users WHERE id = $1 FOR NO KEY UPDATE`,
        [id],
      );
      const current = rows[0];
      if (!current) throw notFound('Person');
      await assertRefs(client, body.tierId, body.teamId);

      const emailChanged = body.email !== undefined && body.email !== current.email;
      if (emailChanged) {
        if (current.verified) {
          throw badRequest(
            'Email addresses can only be changed before someone accepts their invite.',
            { email: 'Already confirmed' },
          );
        }
        const { rows: taken } = await client.query('SELECT 1 FROM users WHERE email = $1', [
          body.email,
        ]);
        if (taken.length)
          throw conflict('Someone with this email address is already on the team.', 'EMAIL_TAKEN');
      }
      const demoting = current.role === 'admin' && body.role === 'member';
      const deactivating = current.active && body.active === false;
      if (deactivating && id === admin.id)
        throw forbidden("You can't deactivate your own account.");
      if (current.role === 'admin' && current.active && (demoting || deactivating)) {
        await assertOtherAdmin(client, id);
      }

      await client.query(
        `UPDATE users
            SET name = COALESCE($2, name),
                email = COALESCE($3, email),
                role = COALESCE($4, role),
                tier_id = CASE WHEN $5 THEN $6::uuid ELSE tier_id END,
                team_id = CASE WHEN $7 THEN $8::uuid ELSE team_id END,
                timezone = CASE WHEN $9 THEN $10 ELSE timezone END,
                deactivated_at = CASE WHEN $11::boolean IS NULL THEN deactivated_at
                                      WHEN $11 THEN NULL
                                      ELSE COALESCE(deactivated_at, now()) END
          WHERE id = $1`,
        [
          id,
          body.name ?? null,
          emailChanged ? body.email : null,
          body.role ?? null,
          body.tierId !== undefined,
          body.tierId ?? null,
          body.teamId !== undefined,
          body.teamId ?? null,
          body.timezone !== undefined,
          body.timezone ?? null,
          body.active ?? null,
        ],
      );
      if (deactivating) await destroyUserSessions(client, id);
      if (emailChanged) {
        // Links, sessions and any password tied to the old (wrong) address are void.
        await client.query(
          'UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
          [id],
        );
        await client.query('UPDATE users SET password_hash = NULL WHERE id = $1', [id]);
        await destroyUserSessions(client, id);
      }

      const action = deactivating
        ? 'user.deactivated'
        : body.active === true && !current.active
          ? 'user.reactivated'
          : 'user.updated';
      await audit(
        client,
        admin.id,
        action,
        { type: 'user', id },
        {
          name: body.name ?? current.name,
          ...Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'active')),
        },
      );
      return emailChanged;
    });
    if (resendInvite) {
      const person = await getPerson(db, id);
      await sendAccountEmail(db, config, person, 'invite', { inviterName: admin.name });
      kick();
    }
    res.json(await getPerson(db, id));
  });

  r.post('/:id/resend-invite', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const person = await getPerson(db, id);
    if (person.status !== 'invited') {
      throw badRequest(
        person.status === 'active'
          ? `${person.name} has already accepted their invite.`
          : `${person.name} is deactivated.`,
      );
    }
    await sendAccountEmail(db, config, person, 'invite', { inviterName: req.user!.name });
    await audit(
      db,
      req.user!.id,
      'user.invite_resent',
      { type: 'user', id },
      { name: person.name },
    );
    kick();
    res.json(person);
  });

  r.delete('/:id', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    if (id === req.user!.id) throw forbidden("You can't delete your own account.");
    await withTransaction(db, async (client) => {
      await lockAdminChanges(client);
      const { rows } = await client.query<{ name: string; role: Role; active: boolean }>(
        'SELECT name, role, (deactivated_at IS NULL) AS active FROM users WHERE id = $1 FOR NO KEY UPDATE',
        [id],
      );
      const person = rows[0];
      if (!person) throw notFound('Person');
      const { rows: shifts } = await client.query(
        'SELECT 1 FROM shifts WHERE user_id = $1 OR published_user_id = $1 LIMIT 1',
        [id],
      );
      if (shifts.length) {
        throw conflict(
          `${person.name} has shifts on the schedule. Deactivate them instead so their history is kept.`,
          'USER_HAS_SHIFTS',
        );
      }
      if (person.role === 'admin' && person.active) await assertOtherAdmin(client, id);
      await client.query('DELETE FROM users WHERE id = $1', [id]);
      await audit(
        client,
        req.user!.id,
        'user.deleted',
        { type: 'user', id },
        { name: person.name },
      );
    });
    res.status(204).end();
  });

  return r;
}
