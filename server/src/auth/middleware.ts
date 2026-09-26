import type { RequestHandler } from 'express';
import type { Config } from '../config';
import type { Db } from '../db';
import { forbidden, unauthorized } from '../errors';
import { clearSessionCookie, resolveSession, SESSION_COOKIE, setSessionCookie } from './sessions';

export function sessionMiddleware(db: Db, config: Config): RequestHandler {
  return async (req, res, next) => {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string' && token.length > 0) {
      const session = await resolveSession(db, token);
      if (session) {
        req.user = session.user;
        req.sessionId = session.sessionId;
        if (session.refreshed) setSessionCookie(res, token, config);
      } else {
        clearSessionCookie(res, config);
      }
    }
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  next(req.user ? undefined : unauthorized());
};

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'admin') return next(forbidden('Only admins can do that'));
  next();
};

/**
 * Defense in depth against CSRF (cookies are already SameSite=Lax): reject
 * state-changing requests whose Origin header names another site.
 */
export function originCheck(config: Config): RequestHandler {
  const safe = new Set(['GET', 'HEAD', 'OPTIONS']);
  return (req, _res, next) => {
    if (safe.has(req.method)) return next();
    const origin = req.get('origin');
    if (!origin || config.allowedOrigins.includes(origin)) return next();
    if (!config.isProduction && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return next();
    }
    next(forbidden('Cross-site request blocked', 'BAD_ORIGIN'));
  };
}
