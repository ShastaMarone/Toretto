import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../deps';
import { parse, zDateTime, zId, zIdParam, zText } from '../lib/validation';
import {
  cancelOpenShift,
  claimOpenShift,
  listOpenShifts,
  openShiftsFor,
  postOpenShift,
  releaseOpenShift,
  reviewOpenShift,
} from '../services/openShifts';

/** Open shifts in your tier, and picking them up. */
export function myOpenShiftRoutes({ db, config, kick }: AppDeps): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    res.json(await openShiftsFor(db, req.user!));
  });

  r.post('/:id/claim', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const openShift = await claimOpenShift(db, config, req.user!, id);
    kick();
    res.json(openShift);
  });

  r.post('/:id/release', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    res.json(await releaseOpenShift(db, req.user!, id));
  });

  return r;
}

/** Admins post open shifts, approve pickups, and take them down. */
export function openShiftAdminRoutes({ db, config, kick }: AppDeps): Router {
  const r = Router();

  r.get('/', async (_req, res) => {
    res.json(await listOpenShifts(db));
  });

  r.post('/', async (req, res) => {
    const body = parse(
      z.object({
        scheduleId: zId.nullable().default(null),
        tierId: zId,
        labelId: zId.nullable().default(null),
        startTime: zDateTime,
        endTime: zDateTime,
        notes: zText(500),
      }),
      req.body,
    );
    const openShift = await postOpenShift(db, config, req.user!, body);
    kick();
    res.status(201).json(openShift);
  });

  for (const [path, decision] of [
    ['approve', 'approved'],
    ['deny', 'denied'],
  ] as const) {
    r.post(`/:id/${path}`, async (req, res) => {
      const { id } = parse(zIdParam, req.params);
      const { note } = parse(z.object({ note: zText(500) }), req.body ?? {});
      const openShift = await reviewOpenShift(db, config, req.user!, id, decision, note);
      kick();
      res.json(openShift);
    });
  }

  r.post('/:id/cancel', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const openShift = await cancelOpenShift(db, config, req.user!, id);
    kick();
    res.json(openShift);
  });

  return r;
}
