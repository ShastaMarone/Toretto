// Create (or promote) an admin from the command line:
//   npm run create-admin -- --email you@example.com --name "Your Name" [--password "..."]
// Without --password, an invite link is printed (and emailed) so they can set one.
import { parseArgs } from 'node:util';
import { hashPassword } from '../src/auth/crypto';
import { issueToken } from '../src/auth/tokens';
import { loadConfig, loadDotEnv } from '../src/config';
import { createPool, withTransaction } from '../src/db';
import { enqueueEmail } from '../src/email/outbox';
import { inviteTemplate } from '../src/email/templates';
import { createLogger } from '../src/logger';
import { migrate } from '../src/migrate';
import { seedDefaults } from '../src/services/defaults';
import { getSettings } from '../src/services/settings';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    password: { type: 'string' },
  },
});
const email = values.email?.trim().toLowerCase();
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error(
    'Usage: npm run create-admin -- --email you@example.com --name "Your Name" [--password "..."]',
  );
  process.exit(1);
}
if (values.password !== undefined && values.password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

loadDotEnv();
const config = loadConfig();
const db = createPool(config.databaseUrl);
await migrate(db, { logger: createLogger('warn') });

const message = await withTransaction(db, async (client) => {
  await seedDefaults(client);
  const passwordHash = values.password ? await hashPassword(values.password) : null;
  const { rows } = await client.query<{ id: string; name: string; verified: boolean }>(
    `INSERT INTO users (name, email, role, password_hash, email_verified_at)
     VALUES ($1, $2, 'admin', $3, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (email) DO UPDATE
        SET role = 'admin', deactivated_at = NULL,
            name = COALESCE($4, users.name),
            password_hash = COALESCE($3, users.password_hash),
            email_verified_at = CASE WHEN $3::text IS NULL THEN users.email_verified_at
                                     ELSE COALESCE(users.email_verified_at, now()) END
     RETURNING id, name, (email_verified_at IS NOT NULL) AS verified`,
    [values.name?.trim() || email.split('@')[0], email, passwordHash, values.name?.trim() || null],
  );
  const user = rows[0]!;
  if (user.verified)
    return `${user.name} <${email}> is an admin and can sign in at ${config.appUrl}/login`;
  const settings = await getSettings(client);
  const url = `${config.appUrl}/set-password?token=${await issueToken(client, user.id, 'invite')}&invite=1`;
  await enqueueEmail(client, {
    userId: user.id,
    to: email,
    kind: 'invite',
    email: inviteTemplate(
      { orgName: settings.orgName, appUrl: config.appUrl },
      { name: user.name, inviterName: null, url },
    ),
  });
  return `${user.name} <${email}> is an admin. They can set a password here (link valid 7 days):\n${url}`;
});

console.log(message);
await db.end();
