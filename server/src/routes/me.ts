import type { CalendarFeed } from '@shared/types';
import { Router } from 'express';
import { z } from 'zod';
import { hashPassword, randomToken, verifyPassword } from '../auth/crypto';
import { destroyUserSessions } from '../auth/sessions';
import type { AppDeps } from '../deps';
import { HttpError } from '../errors';
import { parse, zName, zPassword, zTimezone } from '../lib/validation';
import { calendarFeedUrl } from '../services/calendarFeed';
import { loadAuthUser, toSessionUser } from './auth';

export function meRoutes({ db, config }: AppDeps): Router {
  const r = Router();

  r.patch('/', async (req, res) => {
    const body = parse(
      z.object({
        name: zName('Name', 100).optional(),
        timezone: zTimezone.nullable().optional(),
        timeFormat: z.enum(['12h', '24h']).nullable().optional(),
        notifyTimeOff: z.boolean().optional(),
        notifyConfirmations: z.boolean().optional(),
        notifySwaps: z.boolean().optional(),
      }),
      req.body,
    );
    const user = req.user!;
    await db.query(
      `UPDATE users SET name = COALESCE($2, name),
                        timezone = CASE WHEN $3 THEN $4 ELSE timezone END,
                        notify_time_off = COALESCE($5, notify_time_off),
                        notify_confirmations = COALESCE($6, notify_confirmations),
                        time_format = CASE WHEN $7 THEN $8 ELSE time_format END,
                        notify_swaps = COALESCE($9, notify_swaps)
        WHERE id = $1`,
      [
        user.id,
        body.name ?? null,
        body.timezone !== undefined,
        body.timezone ?? null,
        body.notifyTimeOff ?? null,
        body.notifyConfirmations ?? null,
        body.timeFormat !== undefined,
        body.timeFormat ?? null,
        body.notifySwaps ?? null,
      ],
    );
    res.json({ user: toSessionUser(await loadAuthUser(db, user.id)) });
  });

  r.post('/password', async (req, res) => {
    const body = parse(
      z.object({ currentPassword: z.string().max(200).optional(), newPassword: zPassword }),
      req.body,
    );
    const user = req.user!;
    const { rows } = await db.query<{ hash: string | null }>(
      'SELECT password_hash AS hash FROM users WHERE id = $1',
      [user.id],
    );
    const current = rows[0]?.hash;
    if (current && !(await verifyPassword(body.currentPassword ?? '', current))) {
      throw new HttpError(400, 'WRONG_PASSWORD', 'Your current password is incorrect', {
        fields: { currentPassword: 'Incorrect password' },
      });
    }
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      user.id,
      await hashPassword(body.newPassword),
    ]);
    await destroyUserSessions(db, user.id, req.sessionId);
    res.json({ user: toSessionUser(await loadAuthUser(db, user.id)) });
  });

  r.post('/sign-out-others', async (req, res) => {
    await destroyUserSessions(db, req.user!.id, req.sessionId);
    res.status(204).end();
  });

  // Your shifts as a calendar feed, for Google Calendar and other calendar apps.
  r.get('/calendar', async (req, res) => {
    const { rows } = await db.query<{ token: string | null }>(
      'SELECT calendar_token AS token FROM users WHERE id = $1',
      [req.user!.id],
    );
    const token = rows[0]?.token;
    const body: CalendarFeed = { url: token ? calendarFeedUrl(config, token) : null };
    res.json(body);
  });

  // Turn the feed on, or swap its link for a new one (the old link stops working).
  r.post('/calendar', async (req, res) => {
    const token = randomToken();
    await db.query('UPDATE users SET calendar_token = $2 WHERE id = $1', [req.user!.id, token]);
    const body: CalendarFeed = { url: calendarFeedUrl(config, token) };
    res.json(body);
  });

  r.delete('/calendar', async (req, res) => {
    await db.query('UPDATE users SET calendar_token = NULL WHERE id = $1', [req.user!.id]);
    res.status(204).end();
  });

  return r;
}
