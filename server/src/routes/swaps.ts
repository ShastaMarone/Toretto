import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../deps';
import { parse, zId, zIdParam, zText } from '../lib/validation';
import {
  cancelSwap,
  listMySwaps,
  listSwaps,
  requestSwap,
  respondToSwap,
  reviewSwap,
  swapOptions,
} from '../services/swaps';

/** Offering your shifts to coworkers, and answering their offers. */
export function mySwapRoutes({ db, config, kick }: AppDeps): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    res.json(await listMySwaps(db, req.user!.id));
  });

  r.get('/options', async (req, res) => {
    const { shiftId } = parse(z.object({ shiftId: zId }), req.query);
    res.json(await swapOptions(db, req.user!, shiftId));
  });

  r.post('/', async (req, res) => {
    const body = parse(
      z.object({
        shiftId: zId,
        recipientId: zId,
        returnShiftId: zId.nullable().default(null),
        note: zText(500),
      }),
      req.body,
    );
    const swap = await requestSwap(db, config, req.user!, body);
    kick();
    res.status(201).json(swap);
  });

  for (const answer of ['accept', 'decline'] as const) {
    r.post(`/:id/${answer}`, async (req, res) => {
      const { id } = parse(zIdParam, req.params);
      const swap = await respondToSwap(db, config, req.user!, id, answer);
      kick();
      res.json(swap);
    });
  }

  r.post('/:id/cancel', async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const swap = await cancelSwap(db, config, req.user!, id);
    kick();
    res.json(swap);
  });

  return r;
}

/** Admins approve or decline swaps. */
export function swapAdminRoutes({ db, config, kick }: AppDeps): Router {
  const r = Router();

  r.get('/', async (_req, res) => {
    res.json(await listSwaps(db));
  });

  for (const [path, decision] of [
    ['approve', 'approved'],
    ['deny', 'denied'],
  ] as const) {
    r.post(`/:id/${path}`, async (req, res) => {
      const { id } = parse(zIdParam, req.params);
      const { note } = parse(z.object({ note: zText(500) }), req.body ?? {});
      const swap = await reviewSwap(db, config, req.user!, id, decision, note);
      kick();
      res.json(swap);
    });
  }

  return r;
}
