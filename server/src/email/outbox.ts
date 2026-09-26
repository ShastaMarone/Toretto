import type { Queryable } from '../db';
import type { RenderedEmail } from './templates';

/** Email kinds that contain sign-in links; their bodies are never shown in the admin log. */
export const SENSITIVE_KINDS = [
  'verify_email',
  'invite',
  'reset_password',
  'magic_link',
  'account_exists',
] as const;

export type NotificationKind =
  | (typeof SENSITIVE_KINDS)[number]
  | 'schedule_published'
  | 'schedule_updated'
  | 'schedule_cancelled'
  | 'shift_reminder'
  | 'time_off_requested'
  | 'time_off_reviewed'
  | 'time_off_cancelled';

export interface EnqueueInput {
  userId: string | null;
  to: string;
  kind: NotificationKind;
  email: RenderedEmail;
  scheduleId?: string | null;
  shiftIds?: string[];
}

/** Queue an email for the background worker. Call inside the same transaction as the change. */
export async function enqueueEmail(db: Queryable, input: EnqueueInput): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO notifications (user_id, kind, to_email, subject, html, text, schedule_id, shift_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.userId,
      input.kind,
      input.to,
      input.email.subject,
      input.email.html,
      input.email.text,
      input.scheduleId ?? null,
      input.shiftIds ?? [],
    ],
  );
  return rows[0]!.id;
}
