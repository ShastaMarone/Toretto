import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Bootstrap } from '@shared/types';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { originCheck, requireAdmin, requireAuth, sessionMiddleware } from './auth/middleware';
import type { AppDeps } from './deps';
import { errorHandler, notFound, unauthorized } from './errors';
import { adminRoutes, devRoutes, timeOffAdminRoutes } from './routes/admin';
import { authRoutes, hasAnyUsers, toSessionUser } from './routes/auth';
import { catalogRoutes } from './routes/catalog';
import { meRoutes } from './routes/me';
import { myRoutes, teamRoutes } from './routes/member';
import { scheduleRoutes, shiftRoutes } from './routes/schedules';
import { userRoutes } from './routes/users';
import { getSettings } from './services/settings';

export function createApp(deps: AppDeps): express.Express {
  const { config, db, logger } = deps;
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: config.isProduction
        ? {
            useDefaults: true,
            directives: {
              // Only force https when the app is actually served over https.
              'upgrade-insecure-requests': config.secureCookies ? [] : null,
            },
          }
        : false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  const api = express.Router();
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(originCheck(config));
  api.use(sessionMiddleware(db, config));

  api.get('/health', async (_req, res) => {
    await db.query('SELECT 1');
    res.json({ ok: true });
  });

  api.get('/bootstrap', async (req, res) => {
    const settings = await getSettings(db);
    const body: Bootstrap = {
      user: req.user ? toSessionUser(req.user) : null,
      org: {
        name: settings.orgName,
        timezone: settings.timezone,
        weekStartsOn: settings.weekStartsOn,
      },
      setupRequired: !(await hasAnyUsers(db)),
      selfSignup: settings.selfSignup,
      allowedDomains: settings.allowedDomains,
      devMailbox: config.devMailbox,
      emailConfigured: config.email.transport !== 'console',
    };
    res.json(body);
  });

  // Scheduled jobs, called by Vercel Cron with `Authorization: Bearer $CRON_SECRET`.
  api.get('/cron', async (req, res, next) => {
    const { cronSecret } = config;
    if (!cronSecret || !deps.runJobs) return next(notFound('API endpoint'));
    if (!sameSecret(req.get('authorization') ?? '', `Bearer ${cronSecret}`)) {
      return next(unauthorized('Invalid cron secret'));
    }
    res.json(await deps.runJobs());
  });

  const catalog = catalogRoutes(deps);
  api.use('/auth', authRoutes(deps));
  api.use('/dev', devRoutes(deps));
  api.use('/me', requireAuth, meRoutes(deps));
  api.use('/my', requireAuth, myRoutes(deps));
  api.use('/team', requireAuth, teamRoutes(deps));
  api.use('/tiers', requireAuth, catalog.tiers);
  api.use('/teams', requireAuth, catalog.teams);
  api.use('/labels', requireAuth, catalog.labels);
  api.use('/time-off-types', requireAuth, catalog.timeOffTypes);
  api.use('/users', requireAdmin, userRoutes(deps));
  api.use('/schedules', requireAdmin, scheduleRoutes(deps));
  api.use('/shifts', requireAdmin, shiftRoutes(deps));
  api.use('/time-off', requireAdmin, timeOffAdminRoutes(deps));
  api.use('/admin', requireAdmin, adminRoutes(deps));
  api.use((_req, _res, next) => next(notFound('API endpoint')));
  app.use('/api', api);

  // Serve the built web app (production). In development Vite serves it.
  const staticDir = config.staticDir;
  if (staticDir && existsSync(path.join(staticDir, 'index.html'))) {
    app.use(
      express.static(staticDir, {
        index: false,
        setHeaders(res, filePath) {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
    app.get('/{*path}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  app.use(errorHandler(logger));
  return app;
}

/** Constant-time comparison (hashing first makes the lengths equal). */
function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}
