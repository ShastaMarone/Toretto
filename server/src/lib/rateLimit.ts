import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Config } from '../config';

const passthrough: RequestHandler = (_req, _res, next) => next();

/** Per-IP limit over a 15 minute window (disabled in tests). */
export function limiter(config: Config, limit: number): RequestHandler {
  if (!config.rateLimit) return passthrough;
  return rateLimit({
    windowMs: 15 * 60_000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many attempts. Please wait a few minutes and try again.',
      },
    },
  });
}
