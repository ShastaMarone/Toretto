import { Router } from 'express';
import type { AppDeps } from '../deps';
import { notFound } from '../errors';
import { limiter } from '../lib/rateLimit';
import { calendarFeed, FEED_FILE } from '../services/calendarFeed';

/** Calendar feeds for calendar apps to fetch. There's no sign-in: the secret link is the key. */
export function calendarRoutes({ db, config }: AppDeps): Router {
  const r = Router();

  r.get('/:file', limiter(config, 300), async (req, res) => {
    const { file } = req.params;
    const token = typeof file === 'string' ? FEED_FILE.exec(file)?.[1] : undefined;
    const body = token ? await calendarFeed(db, config, token) : null;
    if (!body) throw notFound('Calendar');
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'inline; filename="shifts.ics"');
    res.send(body);
  });

  return r;
}
