import { issueToken } from '../auth/tokens';
import type { Config } from '../config';
import type { Queryable } from '../db';
import { getSettings } from '../services/settings';
import { enqueueEmail } from './outbox';
import {
  inviteTemplate,
  magicLinkTemplate,
  resetPasswordTemplate,
  verifyEmailTemplate,
  type RenderedEmail,
} from './templates';

export interface Recipient {
  id: string;
  name: string;
  email: string;
}

export type AccountEmailKind = 'verify_email' | 'invite' | 'reset_password' | 'magic_link';

/** Only same-site relative paths may be used as a post-sign-in redirect. */
export function safeNextPath(next: unknown): string | null {
  if (typeof next !== 'string') return null;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
  return next.length <= 300 ? next : null;
}

/** Issue a fresh single-use token and queue the matching email. */
export async function sendAccountEmail(
  db: Queryable,
  config: Config,
  user: Recipient,
  kind: AccountEmailKind,
  extra: { inviterName?: string | null; next?: string | null } = {},
): Promise<void> {
  const settings = await getSettings(db);
  const ctx = { orgName: settings.orgName, appUrl: config.appUrl };
  const token = encodeURIComponent(await issueToken(db, user.id, kind));
  let email: RenderedEmail;
  switch (kind) {
    case 'verify_email':
      email = verifyEmailTemplate(ctx, {
        name: user.name,
        url: `${config.appUrl}/verify-email?token=${token}`,
      });
      break;
    case 'invite':
      email = inviteTemplate(ctx, {
        name: user.name,
        inviterName: extra.inviterName ?? null,
        url: `${config.appUrl}/set-password?token=${token}&invite=1`,
      });
      break;
    case 'reset_password':
      email = resetPasswordTemplate(ctx, {
        name: user.name,
        url: `${config.appUrl}/set-password?token=${token}`,
      });
      break;
    case 'magic_link': {
      const next = safeNextPath(extra.next);
      email = magicLinkTemplate(ctx, {
        name: user.name,
        url: `${config.appUrl}/magic-link?token=${token}${next ? `&next=${encodeURIComponent(next)}` : ''}`,
      });
      break;
    }
  }
  await enqueueEmail(db, { userId: user.id, to: user.email, kind, email });
}
