import type { PersonRow, ShiftView, TeamSchedule, TimeOffEntry } from '@shared/types';
import type { AuthUser } from '../auth/types';
import type { Queryable } from '../db';

/** Published shifts, as the team sees them (never the admin's unpublished edits). */
export const SHIFT_VIEW_SQL = `
  SELECT s.id, s.schedule_id AS "scheduleId", s.published_user_id AS "userId",
         s.published_start_time AS "startTime", s.published_end_time AS "endTime",
         s.published_notes AS notes, s.status, s.confirmed_at AS "confirmedAt",
         CASE WHEN l.id IS NULL THEN NULL
              ELSE json_build_object('id', l.id, 'name', l.name, 'color', l.color) END AS label,
         json_build_object('id', t.id, 'name', t.name, 'color', t.color) AS tier
    FROM shifts s
    JOIN schedules sc ON sc.id = s.schedule_id
    JOIN tiers t ON t.id = sc.tier_id
    LEFT JOIN labels l ON l.id = s.published_label_id
   WHERE s.published_at IS NOT NULL`;

export async function getShiftView(db: Queryable, shiftId: string): Promise<ShiftView | null> {
  const { rows } = await db.query<ShiftView>(`${SHIFT_VIEW_SQL} AND s.id = $1`, [shiftId]);
  return rows[0] ?? null;
}

export async function myShifts(
  db: Queryable,
  userId: string,
  range: { from: string; to: string },
): Promise<ShiftView[]> {
  const { rows } = await db.query<ShiftView>(
    `${SHIFT_VIEW_SQL}
       AND s.published_user_id = $1
       AND s.published_start_time < $3 AND s.published_end_time > $2
     ORDER BY s.published_start_time`,
    [userId, range.from, range.to],
  );
  return rows;
}

export async function teamSchedule(
  db: Queryable,
  viewer: AuthUser,
  input: {
    from: string;
    to: string;
    startDate: string;
    endDate: string;
    tierId: string | null;
    teamId: string | null;
  },
): Promise<TeamSchedule> {
  const { rows: shifts } = await db.query<ShiftView>(
    `${SHIFT_VIEW_SQL}
       AND s.published_start_time < $2 AND s.published_end_time > $1
       AND ($3::uuid IS NULL OR sc.tier_id = $3)
       AND ($4::uuid IS NULL OR EXISTS (
             SELECT 1 FROM users pu WHERE pu.id = s.published_user_id AND pu.team_id = $4))
     ORDER BY s.published_start_time`,
    [input.from, input.to, input.tierId, input.teamId],
  );
  const { rows: people } = await db.query<PersonRow>(
    `SELECT u.id, u.name, u.tier_id AS "tierId", u.team_id AS "teamId",
            (u.deactivated_at IS NULL) AS active
       FROM users u
      WHERE (u.deactivated_at IS NULL
             AND u.tier_id IS NOT NULL
             AND ($1::uuid IS NULL OR u.tier_id = $1)
             AND ($2::uuid IS NULL OR u.team_id = $2))
         OR u.id = ANY($3)
      ORDER BY lower(u.name)`,
    [input.tierId, input.teamId, [...new Set(shifts.map((s) => s.userId))]],
  );
  const { rows: timeOff } = await db.query<TimeOffEntry & { userId: string }>(
    `SELECT r.id, r.user_id AS "userId", r.start_date AS "startDate", r.end_date AS "endDate",
            r.status, tt.name AS "typeName", tt.color AS "typeColor"
       FROM time_off_requests r JOIN time_off_types tt ON tt.id = r.type_id
      WHERE r.user_id = ANY($1) AND r.status = 'approved'
        AND r.start_date <= $3 AND r.end_date >= $2
      ORDER BY r.start_date`,
    [people.map((p) => p.id), input.startDate, input.endDate],
  );
  // Coworkers see that someone is off, not why.
  const visible = timeOff.map((t) =>
    viewer.role === 'admin' || t.userId === viewer.id
      ? t
      : { ...t, typeName: null, typeColor: null },
  );
  return { people, shifts, timeOff: visible };
}
