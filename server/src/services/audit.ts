import type { Queryable } from '../db';

export async function audit(
  db: Queryable,
  actorId: string | null,
  action: string,
  entity: { type: string; id?: string | null },
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [actorId, action, entity.type, entity.id ?? null, JSON.stringify(details)],
  );
}
