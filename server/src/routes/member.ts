import { dayRangeToUtc } from '@shared/time';
import type { ShiftView } from '@shared/types';
import { Router } from 'express';
import { z } from 'zod';
import type { AuthUser } from '../auth/types';
import type { Config } from '../config';
import { withTransaction, type Queryable } from '../db';
import type { AppDeps } from '../deps';
import { shiftsConfirmedTemplate } from '../email/templates';
import { badRequest, notFound } from '../errors';
import { parse, zDate, zId, zIdParam, zText } from '../lib/validation';
import { audit } from '../services/audit';
import { notifyAdmins } from '../services/notify';
import { getSettings, zoneFor } from '../services/settings';
import { cancelTimeOff, forMember, listTimeOff, requestTimeOff } from '../services/timeOff';
import { getShiftView, myShifts, SHIFT_VIEW_SQL, teamSchedule } from '../services/views';

const RangeQuery = z.object({ from: zDate, to: zDate });

function checkRange(from: string, to: string) {
  if (to < from) throw badRequest('`to` must be on or after `from`');
  if (Date.parse(to) - Date.parse(from) > 100 * 86_400_000)
    throw badRequest('Date range is too long');
}

/** Record confirmations and tell the admins who asked to hear about them. */
async function afterConfirm(
  client: Queryable,
  config: Config,
  user: AuthUser,
  shifts: ShiftView[],
): Promise<void> {
  if (!shifts.length) return;
  await audit(
    client,
    user.id,
    shifts.length === 1 ? 'shift.confirmed' : 'shift.confirmed_all',
    { type: 'shift', id: shifts.length === 1 ? shifts[0]!.id : null },
    shifts.length === 1
      ? { startTime: shifts[0]!.startTime, endTime: shifts[0]!.endTime }
      : { count: shifts.length, shiftIds: shifts.map((s) => s.id) },
  );
  await notifyAdmins(client, config, {
    topic: 'confirmations',
    exceptUserId: user.id,
    kind: 'shifts_confirmed',
    shiftIds: shifts.map((s) => s.id),
    render: (ctx, admin) =>
      shiftsConfirmedTemplate(ctx, {
        recipientName: admin.name,
        personName: user.name,
        tz: admin.tz,
        shifts: shifts.map((s) => ({
          id: s.id,
          startTime: s.startTime,
          endTime: s.endTime,
          labelName: s.label?.name ?? null,
          color: s.label?.color ?? s.tier?.color ?? null,
          notes: s.notes,
          needsConfirmation: false,
        })),
      }),
  });
}

/** The signed-in person's own shifts and time off. */
export function myRoutes({ db, config, kick }: AppDeps): Router {
  const r = Router();

  r.get('/shifts', async (req, res) => {
    const { from, to } = parse(RangeQuery, req.query);
    checkRange(from, to);
    const tz = zoneFor(req.user!, await getSettings(db));
    res.json(await myShifts(db, req.user!.id, dayRangeToUtc(from, to, tz)));
  });

  r.post('/shifts/:id/confirm', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const user = req.user!;
    const shift = await withTransaction(db, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE shifts SET status = 'confirmed', confirmed_at = now()
          WHERE id = $1 AND published_user_id = $2 AND published_at IS NOT NULL AND status = 'pending'`,
        [id, user.id],
      );
      const view = await getShiftView(client, id);
      // Someone else's (or an unpublished) shift is reported as not found.
      if (!view || view.userId !== user.id) throw notFound('Shift');
      if (rowCount) await afterConfirm(client, config, user, [view]);
      return view;
    });
    kick();
    res.json(shift);
  });

  // Confirm the given shifts (e.g. from an email), or every upcoming one.
  r.post('/shifts/confirm', async (req, res) => {
    const { shiftIds } = parse(
      z.object({ shiftIds: z.array(zId).min(1).max(200).optional() }),
      req.body ?? {},
    );
    const user = req.user!;
    const confirmed = await withTransaction(db, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `UPDATE shifts SET status = 'confirmed', confirmed_at = now()
          WHERE published_user_id = $1 AND published_at IS NOT NULL AND status = 'pending'
            AND deleted_at IS NULL AND published_end_time > now()
            AND ($2::uuid[] IS NULL OR id = ANY($2))
          RETURNING id`,
        [user.id, shiftIds ?? null],
      );
      const { rows: views } = await client.query<ShiftView>(
        `${SHIFT_VIEW_SQL} AND s.id = ANY($1) ORDER BY s.published_start_time`,
        [rows.map((row) => row.id)],
      );
      await afterConfirm(client, config, user, views);
      return views.length;
    });
    kick();
    res.json({ confirmed });
  });

  r.get('/time-off', async (req, res) => {
    const requests = await listTimeOff(db, { userId: req.user!.id, status: 'all' });
    res.json(requests.map(forMember));
  });

  r.post('/time-off', async (req, res) => {
    const body = parse(
      z.object({ typeId: zId, startDate: zDate, endDate: zDate, note: zText(500) }),
      req.body,
    );
    const request = await requestTimeOff(db, config, req.user!, body);
    kick();
    res.status(201).json(forMember(request));
  });

  r.post('/time-off/:id/cancel', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const request = await cancelTimeOff(db, config, req.user!, id);
    kick();
    res.json(forMember(request));
  });

  return r;
}

/** Everyone's published shifts (every tier and schedule), read-only. */
export function teamRoutes({ db }: AppDeps): Router {
  const r = Router();

  r.get('/schedule', async (req, res) => {
    const query = parse(RangeQuery, req.query);
    checkRange(query.from, query.to);
    const tz = zoneFor(req.user!, await getSettings(db));
    const { from, to } = dayRangeToUtc(query.from, query.to, tz);
    res.json(
      await teamSchedule(db, req.user!, { from, to, startDate: query.from, endDate: query.to }),
    );
  });

  return r;
}
