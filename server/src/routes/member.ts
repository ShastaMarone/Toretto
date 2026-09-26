import { dayRangeToUtc } from '@shared/time';
import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../deps';
import { badRequest, notFound } from '../errors';
import { parse, zDate, zId, zIdParam, zText } from '../lib/validation';
import { audit } from '../services/audit';
import { getSettings, zoneFor } from '../services/settings';
import { cancelTimeOff, forMember, listTimeOff, requestTimeOff } from '../services/timeOff';
import { getShiftView, myShifts, teamSchedule } from '../services/views';

const RangeQuery = z.object({ from: zDate, to: zDate });

function checkRange(from: string, to: string) {
  if (to < from) throw badRequest('`to` must be on or after `from`');
  if (Date.parse(to) - Date.parse(from) > 100 * 86_400_000)
    throw badRequest('Date range is too long');
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
    const { rows } = await db.query<{ startTime: string }>(
      `UPDATE shifts SET status = 'confirmed', confirmed_at = now()
        WHERE id = $1 AND published_user_id = $2 AND published_at IS NOT NULL AND status = 'pending'
        RETURNING published_start_time AS "startTime"`,
      [id, user.id],
    );
    const shift = await getShiftView(db, id);
    // Someone else's (or an unpublished) shift is reported as not found.
    if (!shift || shift.userId !== user.id) throw notFound('Shift');
    if (rows[0]) {
      await audit(
        db,
        user.id,
        'shift.confirmed',
        { type: 'shift', id },
        {
          tierName: shift.tier.name,
          startTime: shift.startTime,
          endTime: shift.endTime,
        },
      );
    }
    res.json(shift);
  });

  // Confirm every pending shift in a schedule, or all upcoming ones.
  r.post('/shifts/confirm', async (req, res) => {
    const { scheduleId } = parse(z.object({ scheduleId: zId.optional() }), req.body ?? {});
    const user = req.user!;
    const { rows } = await db.query<{ id: string }>(
      `UPDATE shifts SET status = 'confirmed', confirmed_at = now()
        WHERE published_user_id = $1 AND published_at IS NOT NULL AND status = 'pending'
          AND deleted_at IS NULL
          AND (($2::uuid IS NULL AND published_end_time > now()) OR schedule_id = $2)
        RETURNING id`,
      [user.id, scheduleId ?? null],
    );
    if (rows.length) {
      await audit(
        db,
        user.id,
        'shift.confirmed_all',
        { type: 'schedule', id: scheduleId ?? null },
        {
          count: rows.length,
          shiftIds: rows.map((row) => row.id),
        },
      );
    }
    res.json({ confirmed: rows.length });
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

/** Everyone's published shifts, read-only. */
export function teamRoutes({ db }: AppDeps): Router {
  const r = Router();

  r.get('/schedule', async (req, res) => {
    const query = parse(
      RangeQuery.extend({ tierId: zId.optional(), teamId: zId.optional() }),
      req.query,
    );
    checkRange(query.from, query.to);
    const tz = zoneFor(req.user!, await getSettings(db));
    const { from, to } = dayRangeToUtc(query.from, query.to, tz);
    res.json(
      await teamSchedule(db, req.user!, {
        from,
        to,
        startDate: query.from,
        endDate: query.to,
        tierId: query.tierId ?? null,
        teamId: query.teamId ?? null,
      }),
    );
  });

  return r;
}
