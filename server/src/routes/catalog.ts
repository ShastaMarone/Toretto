import type { Label, Team, Tier, TimeOffType } from '@shared/types';
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth/middleware';
import type { AppDeps } from '../deps';
import { conflict, notFound } from '../errors';
import { parse, zColor, zId, zIdParam, zName } from '../lib/validation';
import { audit } from '../services/audit';
import { LABEL_SQL } from '../services/schedules';

/**
 * Tiers, teams, labels and time-off types: the admin-defined building blocks.
 * Everyone signed in can read tiers, teams and time-off types; changes are admin-only.
 */
export function catalogRoutes({ db }: AppDeps): {
  tiers: Router;
  teams: Router;
  labels: Router;
  timeOffTypes: Router;
} {
  const tiers = Router();
  const teams = Router();
  const labels = Router();
  const timeOffTypes = Router();

  // ---- Tiers ---------------------------------------------------------------
  const TIER_SQL = `
    SELECT t.id, t.name, t.color, t.sort_order AS "sortOrder",
           (SELECT count(*)::int FROM users u WHERE u.tier_id = t.id AND u.deactivated_at IS NULL) AS "memberCount"
      FROM tiers t`;

  tiers.get('/', async (_req, res) => {
    const { rows } = await db.query<Tier>(`${TIER_SQL} ORDER BY t.sort_order, lower(t.name)`);
    res.json(rows);
  });

  tiers.post('/', requireAdmin, async (req, res) => {
    const body = parse(z.object({ name: zName('Tier name', 60), color: zColor }), req.body);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO tiers (name, color, sort_order)
       VALUES ($1, $2, (SELECT COALESCE(max(sort_order), 0) + 1 FROM tiers)) RETURNING id`,
      [body.name, body.color],
    );
    const id = rows[0]!.id;
    await audit(db, req.user!.id, 'tier.created', { type: 'tier', id }, { name: body.name });
    const { rows: tier } = await db.query<Tier>(`${TIER_SQL} WHERE t.id = $1`, [id]);
    res.status(201).json(tier[0]);
  });

  tiers.patch('/:id', requireAdmin, async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const body = parse(
      z.object({
        name: zName('Tier name', 60).optional(),
        color: zColor.optional(),
        sortOrder: z.number().int().min(0).max(1000).optional(),
      }),
      req.body,
    );
    const { rowCount } = await db.query(
      `UPDATE tiers SET name = COALESCE($2, name), color = COALESCE($3, color),
                        sort_order = COALESCE($4, sort_order)
        WHERE id = $1`,
      [id, body.name ?? null, body.color ?? null, body.sortOrder ?? null],
    );
    if (!rowCount) throw notFound('Tier');
    await audit(db, req.user!.id, 'tier.updated', { type: 'tier', id }, body);
    const { rows } = await db.query<Tier>(`${TIER_SQL} WHERE t.id = $1`, [id]);
    res.json(rows[0]);
  });

  tiers.delete('/:id', requireAdmin, async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const { rows: inUse } = await db.query<{ people: boolean; labels: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM users WHERE tier_id = $1 AND deactivated_at IS NULL) AS people,
              EXISTS (SELECT 1 FROM shifts s JOIN labels l
                        ON l.id = s.label_id OR l.id = s.published_label_id
                       WHERE l.tier_id = $1) AS labels`,
      [id],
    );
    if (inUse[0]?.people) {
      throw conflict(
        'People are still in this tier. Move them to another tier on the People page first, or rename the tier instead.',
        'TIER_HAS_PEOPLE',
      );
    }
    // Deleting the tier deletes its labels, which would silently vanish from shifts.
    if (inUse[0]?.labels) {
      throw conflict(
        "This tier's labels are used on shifts. Rename the tier instead, or delete those labels first.",
        'TIER_LABELS_IN_USE',
      );
    }
    const { rows } = await db.query<{ name: string }>(
      'DELETE FROM tiers WHERE id = $1 RETURNING name',
      [id],
    );
    if (!rows[0]) throw notFound('Tier');
    await audit(db, req.user!.id, 'tier.deleted', { type: 'tier', id }, { name: rows[0].name });
    res.status(204).end();
  });

  // ---- Teams ---------------------------------------------------------------
  const TEAM_SQL = `
    SELECT tm.id, tm.name,
           (SELECT count(*)::int FROM users u WHERE u.team_id = tm.id AND u.deactivated_at IS NULL) AS "memberCount"
      FROM teams tm`;

  teams.get('/', async (_req, res) => {
    const { rows } = await db.query<Team>(`${TEAM_SQL} ORDER BY lower(tm.name)`);
    res.json(rows);
  });

  teams.post('/', requireAdmin, async (req, res) => {
    const body = parse(z.object({ name: zName('Team name', 60) }), req.body);
    const { rows } = await db.query<{ id: string }>(
      'INSERT INTO teams (name) VALUES ($1) RETURNING id',
      [body.name],
    );
    const id = rows[0]!.id;
    await audit(db, req.user!.id, 'team.created', { type: 'team', id }, { name: body.name });
    const { rows: team } = await db.query<Team>(`${TEAM_SQL} WHERE tm.id = $1`, [id]);
    res.status(201).json(team[0]);
  });

  teams.patch('/:id', requireAdmin, async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const body = parse(z.object({ name: zName('Team name', 60) }), req.body);
    const { rowCount } = await db.query('UPDATE teams SET name = $2 WHERE id = $1', [
      id,
      body.name,
    ]);
    if (!rowCount) throw notFound('Team');
    await audit(db, req.user!.id, 'team.updated', { type: 'team', id }, { name: body.name });
    const { rows } = await db.query<Team>(`${TEAM_SQL} WHERE tm.id = $1`, [id]);
    res.json(rows[0]);
  });

  teams.delete('/:id', requireAdmin, async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const { rows } = await db.query<{ name: string }>(
      'DELETE FROM teams WHERE id = $1 RETURNING name',
      [id],
    );
    if (!rows[0]) throw notFound('Team');
    await audit(db, req.user!.id, 'team.deleted', { type: 'team', id }, { name: rows[0].name });
    res.status(204).end();
  });

  // ---- Labels (admin only) -------------------------------------------------
  labels.get('/', requireAdmin, async (req, res) => {
    const { tierId } = parse(z.object({ tierId: zId.optional() }), req.query);
    const { rows } = await db.query<Label>(
      `${LABEL_SQL}
        WHERE ($1::uuid IS NULL OR l.tier_id = $1 OR l.tier_id IS NULL)
        ORDER BY (l.tier_id IS NULL) DESC, lower(l.name)`,
      [tierId ?? null],
    );
    res.json(rows);
  });

  labels.post('/', requireAdmin, async (req, res) => {
    const body = parse(
      z.object({ tierId: zId.nullable(), name: zName('Label name', 40), color: zColor }),
      req.body,
    );
    if (body.tierId) {
      const { rows } = await db.query('SELECT 1 FROM tiers WHERE id = $1', [body.tierId]);
      if (!rows.length) throw notFound('Tier');
    }
    const { rows } = await db.query<{ id: string }>(
      'INSERT INTO labels (tier_id, name, color) VALUES ($1, $2, $3) RETURNING id',
      [body.tierId, body.name, body.color],
    );
    const id = rows[0]!.id;
    await audit(db, req.user!.id, 'label.created', { type: 'label', id }, { name: body.name });
    const { rows: label } = await db.query<Label>(`${LABEL_SQL} WHERE l.id = $1`, [id]);
    res.status(201).json(label[0]);
  });

  labels.patch('/:id', requireAdmin, async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const body = parse(
      z.object({
        name: zName('Label name', 40).optional(),
        color: zColor.optional(),
        tierId: zId.nullable().optional(),
      }),
      req.body,
    );
    const { rowCount } = await db.query(
      `UPDATE labels SET name = COALESCE($2, name), color = COALESCE($3, color),
                         tier_id = CASE WHEN $4 THEN $5::uuid ELSE tier_id END
        WHERE id = $1`,
      [id, body.name ?? null, body.color ?? null, body.tierId !== undefined, body.tierId ?? null],
    );
    if (!rowCount) throw notFound('Label');
    await audit(db, req.user!.id, 'label.updated', { type: 'label', id }, body);
    const { rows } = await db.query<Label>(`${LABEL_SQL} WHERE l.id = $1`, [id]);
    res.json(rows[0]);
  });

  labels.delete('/:id', requireAdmin, async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const { rows } = await db.query<{ name: string }>(
      'DELETE FROM labels WHERE id = $1 RETURNING name',
      [id],
    );
    if (!rows[0]) throw notFound('Label');
    await audit(db, req.user!.id, 'label.deleted', { type: 'label', id }, { name: rows[0].name });
    res.status(204).end();
  });

  // ---- Time-off types ------------------------------------------------------
  const TYPE_SQL = `
    SELECT id, name, color, paid, (archived_at IS NOT NULL) AS archived, sort_order AS "sortOrder"
      FROM time_off_types`;

  timeOffTypes.get('/', async (req, res) => {
    const includeArchived = req.user!.role === 'admin' && req.query.all === '1';
    const { rows } = await db.query<TimeOffType>(
      `${TYPE_SQL} WHERE $1 OR archived_at IS NULL ORDER BY sort_order, lower(name)`,
      [includeArchived],
    );
    res.json(rows);
  });

  timeOffTypes.post('/', requireAdmin, async (req, res) => {
    const body = parse(
      z.object({ name: zName('Name', 40), color: zColor, paid: z.boolean().default(true) }),
      req.body,
    );
    const { rows } = await db.query<TimeOffType>(
      `INSERT INTO time_off_types (name, color, paid, sort_order)
       VALUES ($1, $2, $3, (SELECT COALESCE(max(sort_order), 0) + 1 FROM time_off_types))
       RETURNING id, name, color, paid, false AS archived, sort_order AS "sortOrder"`,
      [body.name, body.color, body.paid],
    );
    await audit(
      db,
      req.user!.id,
      'time_off_type.created',
      { type: 'time_off_type', id: rows[0]!.id },
      {
        name: body.name,
      },
    );
    res.status(201).json(rows[0]);
  });

  timeOffTypes.patch('/:id', requireAdmin, async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const body = parse(
      z.object({
        name: zName('Name', 40).optional(),
        color: zColor.optional(),
        paid: z.boolean().optional(),
        archived: z.boolean().optional(),
      }),
      req.body,
    );
    const { rows } = await db.query<TimeOffType>(
      `UPDATE time_off_types
          SET name = COALESCE($2, name), color = COALESCE($3, color), paid = COALESCE($4, paid),
              archived_at = CASE WHEN $5::boolean IS NULL THEN archived_at
                                 WHEN $5 THEN COALESCE(archived_at, now()) ELSE NULL END
        WHERE id = $1
        RETURNING id, name, color, paid, (archived_at IS NOT NULL) AS archived, sort_order AS "sortOrder"`,
      [id, body.name ?? null, body.color ?? null, body.paid ?? null, body.archived ?? null],
    );
    if (!rows[0]) throw notFound('Time-off type');
    await audit(db, req.user!.id, 'time_off_type.updated', { type: 'time_off_type', id }, body);
    res.json(rows[0]);
  });

  timeOffTypes.delete('/:id', requireAdmin, async (req, res) => {
    const { id } = parse(zIdParam, req.params);
    const { rows: used } = await db.query(
      'SELECT 1 FROM time_off_requests WHERE type_id = $1 LIMIT 1',
      [id],
    );
    if (used.length) {
      throw conflict('This type is used by existing requests. Archive it instead.', 'TYPE_IN_USE');
    }
    const { rows } = await db.query<{ name: string }>(
      'DELETE FROM time_off_types WHERE id = $1 RETURNING name',
      [id],
    );
    if (!rows[0]) throw notFound('Time-off type');
    await audit(
      db,
      req.user!.id,
      'time_off_type.deleted',
      { type: 'time_off_type', id },
      {
        name: rows[0].name,
      },
    );
    res.status(204).end();
  });

  return { tiers, teams, labels, timeOffTypes };
}
