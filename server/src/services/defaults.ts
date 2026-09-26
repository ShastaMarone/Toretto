import type { Queryable } from '../db';

export const DEFAULT_TIERS = [
  { name: 'Tier 1', color: '#4f46e5' },
  { name: 'Tier 2', color: '#0891b2' },
  { name: 'Tier 3', color: '#c026d3' },
];

export const DEFAULT_LABELS = [
  { name: 'On-Call', color: '#dc2626' },
  { name: 'Training', color: '#16a34a' },
  { name: 'Overtime', color: '#ea580c' },
];

/** Starter tiers and labels for a brand-new organization (admins can rename or delete them). */
export async function seedDefaults(db: Queryable): Promise<void> {
  const { rows } = await db.query('SELECT 1 FROM tiers LIMIT 1');
  if (rows.length) return;
  for (const [i, tier] of DEFAULT_TIERS.entries()) {
    await db.query('INSERT INTO tiers (name, color, sort_order) VALUES ($1, $2, $3)', [
      tier.name,
      tier.color,
      i + 1,
    ]);
  }
  for (const label of DEFAULT_LABELS) {
    await db.query('INSERT INTO labels (tier_id, name, color) VALUES (NULL, $1, $2)', [
      label.name,
      label.color,
    ]);
  }
}
