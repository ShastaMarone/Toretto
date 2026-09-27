import type { Queryable } from '../db';
import { TIME_OFF_SPAN } from './timeOff';

/** Something that has someone busy: a shift (draft or published) or approved time off. */
export interface Busy {
  userId: string;
  /** For shifts, so a swap can leave out the shifts that are changing hands. */
  shiftId: string | null;
  from: string;
  to: string;
  kind: 'shift' | 'time_off';
}

/**
 * What these people have on between from and to. Drafts (unpublished
 * changes) are only for admins: telling a team member "Working then" about a
 * shift they can't see yet would give it away.
 */
export async function busyBetween(
  db: Queryable,
  userIds: string[],
  from: string,
  to: string,
  { drafts }: { drafts: boolean },
): Promise<Busy[]> {
  const draftShifts = drafts
    ? `SELECT s.user_id AS "userId", s.id AS "shiftId", s.start_time AS "from", s.end_time AS "to",
              'shift' AS kind
         FROM shifts s
        WHERE s.user_id = ANY($1) AND s.deleted_at IS NULL AND s.start_time < $3 AND s.end_time > $2
       UNION ALL`
    : '';
  const { rows } = await db.query<Busy>(
    `${draftShifts}
     SELECT s.published_user_id AS "userId", s.id AS "shiftId",
            s.published_start_time AS "from", s.published_end_time AS "to", 'shift' AS kind
       FROM shifts s
      WHERE s.published_at IS NOT NULL AND s.published_user_id = ANY($1)
        AND s.published_start_time < $3 AND s.published_end_time > $2
     UNION ALL
     SELECT t.user_id, NULL, lower(t.span), upper(t.span), 'time_off'
       FROM (SELECT r.user_id, ${TIME_OFF_SPAN} AS span
               FROM time_off_requests r CROSS JOIN org_settings os
              WHERE r.user_id = ANY($1) AND r.status = 'approved') t
      WHERE t.span && tstzrange($2, $3)`,
    [userIds, from, to],
  );
  return rows;
}

/** Why someone can't work from..to ("Working then", "Off then"), or null if they can. */
export function busyReason(
  busy: Busy[],
  userId: string,
  from: string,
  to: string,
  ignoreShiftIds: string[] = [],
): string | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  const clashes = busy.filter(
    (b) =>
      b.userId === userId &&
      !(b.shiftId && ignoreShiftIds.includes(b.shiftId)) &&
      Date.parse(b.from) < end &&
      Date.parse(b.to) > start,
  );
  if (clashes.some((b) => b.kind === 'shift')) return 'Working then';
  return clashes.length ? 'Off then' : null;
}
