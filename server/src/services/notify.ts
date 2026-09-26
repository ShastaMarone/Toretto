import type { Config } from '../config';
import type { Queryable } from '../db';
import { enqueueEmail, type NotificationKind } from '../email/outbox';
import type { EmailContext, RenderedEmail } from '../email/templates';
import type { TimeFormat } from '@shared/types';
import { getSettings, timeFormatFor, zoneFor } from './settings';

/** What an admin can choose to be emailed about (see Profile). */
export type AdminTopic = 'time_off' | 'confirmations' | 'swaps';

const PREFERENCE: Record<AdminTopic, string> = {
  time_off: 'notify_time_off',
  confirmations: 'notify_confirmations',
  swaps: 'notify_swaps',
};

/**
 * Email every active admin who wants to hear about `topic`, except the person
 * who did the thing. Returns how many emails were queued.
 */
export async function notifyAdmins(
  client: Queryable,
  config: Config,
  input: {
    topic: AdminTopic;
    exceptUserId: string;
    kind: NotificationKind;
    shiftIds?: string[];
    render: (
      ctx: EmailContext,
      admin: { name: string; tz: string; timeFormat: TimeFormat },
    ) => RenderedEmail;
  },
): Promise<number> {
  const settings = await getSettings(client);
  const ctx = { orgName: settings.orgName, appUrl: config.appUrl };
  const { rows: admins } = await client.query<{
    id: string;
    name: string;
    email: string;
    timezone: string | null;
    timeFormat: TimeFormat | null;
  }>(
    `SELECT id, name, email, timezone, time_format AS "timeFormat" FROM users
      WHERE role = 'admin' AND deactivated_at IS NULL AND email_verified_at IS NOT NULL
        AND id <> $1 AND ${PREFERENCE[input.topic]}`,
    [input.exceptUserId],
  );
  for (const admin of admins) {
    await enqueueEmail(client, {
      userId: admin.id,
      to: admin.email,
      kind: input.kind,
      shiftIds: input.shiftIds,
      email: input.render(ctx, {
        name: admin.name,
        tz: zoneFor(admin, settings),
        timeFormat: timeFormatFor(admin, settings),
      }),
    });
  }
  return admins.length;
}
