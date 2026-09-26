import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../deps';
import { badRequest } from '../errors';
import { parse, zDate, zDateTime, zId, zIdParam, zName, zText } from '../lib/validation';
import { deleteSchedule, discardChanges, publishSchedule } from '../services/publish';
import {
  copyShifts,
  createSchedule,
  getScheduleRange,
  getScheduleSummary,
  listSchedules,
  renameSchedule,
  type DateRange,
} from '../services/schedules';
import { createShift, deleteShift, restoreShift, updateShift } from '../services/shifts';

const ShiftBody = z.object({
  userId: zId,
  labelId: zId.nullable().default(null),
  startTime: zDateTime,
  endTime: zDateTime,
  notes: zText(500),
});

/**
 * Edits send only what changed; a missing field means "leave it alone".
 * (Not ShiftBody.partial(): Zod keeps field defaults inside optional fields,
 * so a missing labelId would become null and silently drop the label.)
 */
const ShiftPatchBody = z.object({
  userId: zId.optional(),
  labelId: zId.nullable().optional(),
  startTime: zDateTime.optional(),
  endTime: zDateTime.optional(),
  notes: zText(500).optional(),
});

const Range = z.object({ from: zDate, to: zDate });

/** An optional date range: both ends, or neither (meaning every date). */
function optionalRange(body: unknown): DateRange | null {
  const { from, to } = parse(
    z.object({ from: zDate.optional(), to: zDate.optional() }),
    body ?? {},
  );
  if (!from && !to) return null;
  if (!from || !to) throw badRequest('Send both `from` and `to`, or neither');
  return { from, to };
}

/** Admin-only: build, publish and manage schedules. */
export function scheduleRoutes({ db, config, kick }: AppDeps): Router {
  const r = Router();

  r.get('/', async (_req, res) => {
    res.json(await listSchedules(db));
  });

  r.post('/', async (req, res) => {
    const body = parse(z.object({ name: zName('Name', 80) }), req.body);
    res.status(201).json(await createSchedule(db, req.user!, body));
  });

  // The builder: shifts, people, labels and time off for a range of days.
  r.get('/:id', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    res.json(await getScheduleRange(db, id, parse(Range, req.query)));
  });

  r.patch('/:id', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const { name } = parse(z.object({ name: zName('Name', 80) }), req.body);
    res.json(await renameSchedule(db, req.user!, id, name));
  });

  r.delete('/:id', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const result = await deleteSchedule(db, config, id, req.user!);
    kick();
    res.json(result);
  });

  r.post('/:id/publish', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const result = await publishSchedule(db, config, id, req.user!, optionalRange(req.body));
    kick();
    res.json(result);
  });

  r.post('/:id/discard-changes', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const result = await discardChanges(db, id, req.user!, optionalRange(req.body));
    res.json({ ...result, schedule: await getScheduleSummary(db, id) });
  });

  // Copy one stretch of days (e.g. last week) into another.
  r.post('/:id/copy', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const body = parse(Range.extend({ targetStart: zDate }), req.body);
    res.json(await copyShifts(db, req.user!, id, body));
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
    const body = parse(ShiftPatchBody, req.body);
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
