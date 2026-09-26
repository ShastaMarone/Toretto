import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../deps';
import { parse, zDate, zDateTime, zId, zIdParam, zText } from '../lib/validation';
import { deleteSchedule, discardChanges, publishSchedule } from '../services/publish';
import {
  assertNoScheduleOverlap,
  createSchedule,
  getScheduleDetail,
  getScheduleSummary,
  listSchedules,
  lockSchedule,
  scheduleTitle,
} from '../services/schedules';
import { createShift, deleteShift, restoreShift, updateShift } from '../services/shifts';
import { withTransaction } from '../db';
import { badRequest, conflict } from '../errors';
import { audit } from '../services/audit';
import { getSettings } from '../services/settings';
import { diffDays } from '@shared/time';

const ShiftBody = z.object({
  userId: zId,
  labelId: zId.nullable().default(null),
  startTime: zDateTime,
  endTime: zDateTime,
  notes: zText(500),
});

/** Admin-only: build, publish and manage tier schedules. */
export function scheduleRoutes({ db, config, kick }: AppDeps): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const filters = parse(
      z.object({
        tierId: zId.optional(),
        status: z.enum(['draft', 'published']).optional(),
        endingAfter: zDate.optional(),
      }),
      req.query,
    );
    res.json(await listSchedules(db, filters));
  });

  r.post('/', async (req, res) => {
    const body = parse(
      z.object({
        tierId: zId,
        startDate: zDate,
        endDate: zDate,
        name: zText(80),
        copyFromScheduleId: zId.nullable().default(null),
      }),
      req.body,
    );
    res.status(201).json(await createSchedule(db, req.user!, body));
  });

  r.get('/:id', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    res.json(await getScheduleDetail(db, id));
  });

  r.patch('/:id', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const body = parse(
      z.object({
        name: zText(80).optional(),
        startDate: zDate.optional(),
        endDate: zDate.optional(),
      }),
      req.body,
    );
    await withTransaction(db, async (client) => {
      const schedule = await lockSchedule(client, id);
      const startDate = body.startDate ?? schedule.startDate;
      const endDate = body.endDate ?? schedule.endDate;
      if (endDate < startDate) throw badRequest('End date must be on or after the start date');
      if (diffDays(startDate, endDate) >= 42)
        throw badRequest('A schedule can cover at most 6 weeks');
      if (startDate !== schedule.startDate || endDate !== schedule.endDate) {
        await assertNoScheduleOverlap(client, schedule.tierId, startDate, endDate, id);
        const { timezone } = await getSettings(client);
        const { rows } = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM shifts
            WHERE schedule_id = $1 AND deleted_at IS NULL
              AND ((start_time AT TIME ZONE $4)::date < $2 OR (start_time AT TIME ZONE $4)::date > $3)`,
          [id, startDate, endDate, timezone],
        );
        if (rows[0]!.count > 0) {
          throw conflict(
            `${rows[0]!.count} shift(s) fall outside the new dates. Move or delete them first.`,
            'SHIFTS_OUTSIDE_RANGE',
          );
        }
      }
      await client.query(
        `UPDATE schedules SET name = CASE WHEN $2 THEN $3 ELSE name END, start_date = $4, end_date = $5
          WHERE id = $1`,
        [id, body.name !== undefined, body.name ?? null, startDate, endDate],
      );
      await audit(
        client,
        req.user!.id,
        'schedule.updated',
        { type: 'schedule', id },
        {
          title: scheduleTitle({ tierName: schedule.tierName, startDate, endDate }),
        },
      );
    });
    res.json(await getScheduleSummary(db, id));
  });

  r.delete('/:id', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const result = await deleteSchedule(db, config, id, req.user!);
    kick();
    res.json(result);
  });

  r.post('/:id/publish', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const result = await publishSchedule(db, config, id, req.user!);
    kick();
    res.json(result);
  });

  r.post('/:id/discard-changes', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    await discardChanges(db, id, req.user!);
    res.json(await getScheduleDetail(db, id));
  });

  r.post('/:id/shifts', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const body = parse(ShiftBody, req.body);
    res.status(201).json(await createShift(db, req.user!, id, body));
  });

  return r;
}

/** Admin-only: edit individual shifts in the working copy. */
export function shiftRoutes({ db }: AppDeps): Router {
  const r = Router();

  r.patch('/:id', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const body = parse(ShiftBody.partial().extend({ notes: zText(500).optional() }), req.body);
    res.json(await updateShift(db, id, body));
  });

  r.delete('/:id', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    res.json(await deleteShift(db, id));
  });

  r.post('/:id/restore', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    res.json(await restoreShift(db, id));
  });

  return r;
}
