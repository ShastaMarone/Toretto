// Load demo data: `npm run seed` (add `-- --reset` to wipe existing data first).
// Everyone's password is "password123". Never run this against production.
import { parseArgs } from 'node:util';
import { addDays, startOfWeek, todayIn, shiftTimesFromLocal } from '@shared/time';
import { hashPassword } from '../src/auth/crypto';
import { AUTH_USER_COLUMNS, type AuthUser } from '../src/auth/types';
import { loadConfig, loadDotEnv } from '../src/config';
import { createPool, withTransaction } from '../src/db';
import { createLogger } from '../src/logger';
import { migrate } from '../src/migrate';
import { seedDefaults } from '../src/services/defaults';
import { publishSchedule } from '../src/services/publish';
import { createSchedule } from '../src/services/schedules';
import { createShift } from '../src/services/shifts';

const { values } = parseArgs({
  options: {
    reset: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    timezone: { type: 'string' },
  },
});

loadDotEnv();
const config = loadConfig();
if (config.isProduction && !values.force) {
  console.error(
    'Refusing to load demo data with NODE_ENV=production (pass --force if you really mean it).',
  );
  process.exit(1);
}
const db = createPool(config.databaseUrl);
await migrate(db, { logger: createLogger('warn') });

const { rows: existing } = await db.query('SELECT 1 FROM users LIMIT 1');
if (existing.length && !values.reset) {
  console.error(
    'The database already has data. Run `npm run seed -- --reset` to wipe it and load demo data.',
  );
  await db.end();
  process.exit(1);
}

const timezone = values.timezone ?? process.env.DEMO_TIMEZONE ?? 'America/Toronto';
const PASSWORD = 'password123';

await withTransaction(db, async (client) => {
  if (values.reset) {
    await client.query(`TRUNCATE users, tiers, teams, labels, schedules, shifts, sessions, auth_tokens,
                        time_off_requests, notifications, audit_log RESTART IDENTITY CASCADE`);
  }
  await client.query(
    `UPDATE org_settings SET org_name = 'Northwind Support', timezone = $1, week_starts_on = 1,
            reminder_hours = 24, self_signup = false, allowed_domains = '{}'`,
    [timezone],
  );
  await seedDefaults(client);
});

const hash = await hashPassword(PASSWORD);
const tierId = async (name: string) =>
  (await db.query<{ id: string }>('SELECT id FROM tiers WHERE name = $1', [name])).rows[0]!.id;
const tiers = {
  t1: await tierId('Tier 1'),
  t2: await tierId('Tier 2'),
  t3: await tierId('Tier 3'),
};

const teamIds: Record<string, string> = {};
for (const name of ['East', 'West']) {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO teams (name) VALUES ($1) RETURNING id',
    [name],
  );
  teamIds[name] = rows[0]!.id;
}

const labelIds: Record<string, string> = {};
const { rows: globalLabels } = await db.query<{ id: string; name: string }>(
  'SELECT id, name FROM labels',
);
for (const row of globalLabels) labelIds[row.name] = row.id;
for (const [tier, name, color] of [
  [tiers.t1, 'Chat Queue', '#2563eb'],
  [tiers.t2, 'Escalations', '#7c3aed'],
  [tiers.t3, 'Incident Lead', '#be123c'],
] as const) {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO labels (tier_id, name, color) VALUES ($1, $2, $3) RETURNING id',
    [tier, name, color],
  );
  labelIds[name] = rows[0]!.id;
}

const people = [
  {
    key: 'alex',
    name: 'Alex Rivera',
    email: 'admin@example.com',
    role: 'admin',
    tier: null,
    team: 'East',
  },
  {
    key: 'jordan',
    name: 'Jordan Lee',
    email: 'jordan@example.com',
    role: 'member',
    tier: tiers.t1,
    team: 'East',
  },
  {
    key: 'priya',
    name: 'Priya Patel',
    email: 'priya@example.com',
    role: 'member',
    tier: tiers.t1,
    team: 'East',
  },
  {
    key: 'sam',
    name: 'Sam Chen',
    email: 'sam@example.com',
    role: 'member',
    tier: tiers.t1,
    team: 'West',
  },
  {
    key: 'maria',
    name: 'Maria Garcia',
    email: 'maria@example.com',
    role: 'member',
    tier: tiers.t1,
    team: 'West',
  },
  {
    key: 'taylor',
    name: 'Taylor Brooks',
    email: 'taylor@example.com',
    role: 'member',
    tier: tiers.t2,
    team: 'East',
  },
  {
    key: 'chris',
    name: 'Chris Nguyen',
    email: 'chris@example.com',
    role: 'member',
    tier: tiers.t2,
    team: 'West',
  },
  {
    key: 'dana',
    name: 'Dana Kim',
    email: 'dana@example.com',
    role: 'member',
    tier: tiers.t2,
    team: 'West',
  },
  {
    key: 'morgan',
    name: 'Morgan Blake',
    email: 'morgan@example.com',
    role: 'member',
    tier: tiers.t3,
    team: 'East',
  },
  {
    key: 'riley',
    name: 'Riley Adams',
    email: 'riley@example.com',
    role: 'member',
    tier: tiers.t3,
    team: 'West',
  },
] as const;

const ids: Record<string, string> = {};
for (const p of people) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, role, tier_id, team_id, email_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`,
    [p.name, p.email, hash, p.role, p.tier, teamIds[p.team]],
  );
  ids[p.key] = rows[0]!.id;
}
// Someone who hasn't accepted their invite yet.
await db.query(
  `INSERT INTO users (name, email, role, tier_id, team_id, invited_at, invited_by)
   VALUES ('Jamie Fox', 'jamie@example.com', 'member', $1, $2, now(), $3)`,
  [tiers.t1, teamIds.West, ids.alex],
);

const { rows: adminRows } = await db.query<AuthUser>(
  `SELECT ${AUTH_USER_COLUMNS} FROM users u WHERE u.id = $1`,
  [ids.alex],
);
const admin = adminRows[0]!;

const thisWeek = startOfWeek(todayIn(timezone), 1);
const nextWeek = addDays(thisWeek, 7);
const weekdays = (start: string) => [0, 1, 2, 3, 4].map((d) => addDays(start, d));

type Plan = {
  person: string;
  days: string[];
  start: string;
  end: string;
  label?: string;
  notes?: string;
};

async function buildSchedule(tier: string, start: string, plans: Plan[]) {
  const { schedule } = await createSchedule(db, admin, {
    tierId: tier,
    startDate: start,
    endDate: addDays(start, 6),
    name: null,
    copyFromScheduleId: null,
  });
  for (const plan of plans) {
    for (const day of plan.days) {
      await createShift(db, admin, schedule.id, {
        userId: ids[plan.person]!,
        labelId: plan.label ? labelIds[plan.label]! : null,
        ...shiftTimesFromLocal(day, plan.start, plan.end, timezone),
        notes: plan.notes ?? null,
      });
    }
  }
  return schedule.id;
}

// ---- This week: every tier published --------------------------------------
const w = weekdays(thisWeek);
const tier1Now = await buildSchedule(tiers.t1, thisWeek, [
  { person: 'jordan', days: w, start: '08:00', end: '16:00' },
  { person: 'priya', days: w, start: '08:00', end: '16:00', label: 'Chat Queue' },
  { person: 'sam', days: w, start: '12:00', end: '20:00' },
  { person: 'maria', days: w.slice(0, 4), start: '12:00', end: '20:00' },
  {
    person: 'maria',
    days: [w[4]!],
    start: '09:00',
    end: '13:00',
    label: 'Training',
    notes: 'New ticketing tool onboarding',
  },
  {
    person: 'jordan',
    days: [addDays(thisWeek, 5)],
    start: '09:00',
    end: '17:00',
    label: 'Overtime',
  },
]);
const tier2Now = await buildSchedule(tiers.t2, thisWeek, [
  { person: 'taylor', days: [w[0]!, w[1]!, w[2]!, w[4]!], start: '09:00', end: '17:00' },
  { person: 'chris', days: w, start: '09:00', end: '17:00', label: 'Escalations' },
  { person: 'dana', days: w, start: '10:00', end: '18:00' },
]);
const tier3Now = await buildSchedule(tiers.t3, thisWeek, [
  { person: 'morgan', days: [w[0]!, w[2]!], start: '09:00', end: '17:00', label: 'Incident Lead' },
  { person: 'morgan', days: [w[1]!, w[3]!, w[4]!], start: '09:00', end: '17:00' },
  { person: 'riley', days: w.slice(0, 4), start: '11:00', end: '19:00' },
  {
    person: 'riley',
    days: [addDays(thisWeek, 5), addDays(thisWeek, 6)],
    start: '08:00',
    end: '20:00',
    label: 'On-Call',
  },
]);
for (const id of [tier1Now, tier2Now, tier3Now]) await publishSchedule(db, config, id, admin);

// Most of this week's shifts are confirmed; a few are still pending.
await db.query(
  `UPDATE shifts SET status = 'confirmed', confirmed_at = published_at + interval '3 hours'
    WHERE published_at IS NOT NULL AND schedule_id = ANY($1)
      AND NOT (published_user_id = ANY($2))`,
  [
    [tier1Now, tier2Now, tier3Now],
    [ids.sam, ids.dana],
  ],
);

// ---- Next week: every tier published; Tier 1 has a few unpublished edits --------
const n = weekdays(nextWeek);
const tier2Next = await buildSchedule(tiers.t2, nextWeek, [
  { person: 'taylor', days: n, start: '09:00', end: '17:00' },
  { person: 'chris', days: n, start: '09:00', end: '17:00', label: 'Escalations' },
  { person: 'dana', days: n.slice(1), start: '10:00', end: '18:00' },
]);
const tier3Next = await buildSchedule(tiers.t3, nextWeek, [
  { person: 'morgan', days: n, start: '09:00', end: '17:00', label: 'Incident Lead' },
  { person: 'riley', days: n.slice(0, 3), start: '11:00', end: '19:00' },
  {
    person: 'riley',
    days: [addDays(nextWeek, 5), addDays(nextWeek, 6)],
    start: '08:00',
    end: '20:00',
    label: 'On-Call',
  },
]);
const tier1Next = await buildSchedule(tiers.t1, nextWeek, [
  { person: 'jordan', days: n, start: '08:00', end: '16:00' },
  { person: 'priya', days: n.slice(0, 2), start: '08:00', end: '16:00', label: 'Chat Queue' },
  { person: 'sam', days: n.slice(1), start: '12:00', end: '20:00' },
  { person: 'maria', days: n, start: '12:00', end: '20:00' },
]);
for (const id of [tier1Next, tier2Next, tier3Next]) await publishSchedule(db, config, id, admin);
await db.query(
  `UPDATE shifts SET status = 'confirmed', confirmed_at = now()
    WHERE schedule_id = ANY($1) AND published_user_id = ANY($2)`,
  [
    [tier1Next, tier2Next, tier3Next],
    [ids.jordan, ids.chris, ids.morgan],
  ],
);

// Edits made after publishing (shown as "Edit"/"New" in the builder until re-published).
const {
  rows: [samTuesday],
} = await db.query<{ id: string }>(
  `SELECT id FROM shifts WHERE schedule_id = $1 AND user_id = $2 ORDER BY start_time LIMIT 1`,
  [tier1Next, ids.sam],
);
await db.query(
  "UPDATE shifts SET start_time = start_time + interval '1 hour', end_time = end_time + interval '1 hour' WHERE id = $1",
  [samTuesday!.id],
);
await createShift(db, admin, tier1Next, {
  userId: ids.jordan!,
  labelId: labelIds.Overtime!,
  ...shiftTimesFromLocal(addDays(nextWeek, 5), '09:00', '15:00', timezone),
  notes: 'Weekend backlog cleanup',
});

// ---- The week after: Tier 1 draft, copied from next week ------------------
await createSchedule(db, admin, {
  tierId: tiers.t1,
  startDate: addDays(nextWeek, 7),
  endDate: addDays(nextWeek, 13),
  name: null,
  copyFromScheduleId: tier1Next,
});

// ---- Time off -------------------------------------------------------------
const typeId = async (name: string) =>
  (await db.query<{ id: string }>('SELECT id FROM time_off_types WHERE name = $1', [name])).rows[0]!
    .id;
const timeOff = [
  {
    person: 'priya',
    type: 'Vacation',
    start: n[2]!,
    end: n[4]!,
    status: 'approved',
    note: 'Family trip',
  },
  {
    person: 'sam',
    type: 'Personal Day',
    start: n[0]!,
    end: n[0]!,
    status: 'pending',
    note: 'Moving apartments',
  },
  { person: 'taylor', type: 'Sick Day', start: w[3]!, end: w[3]!, status: 'approved', note: null },
  {
    person: 'maria',
    type: 'Paid Holiday',
    start: addDays(nextWeek, 9),
    end: addDays(nextWeek, 9),
    status: 'pending',
    note: null,
  },
];
for (const t of timeOff) {
  await db.query(
    `INSERT INTO time_off_requests (user_id, type_id, start_date, end_date, note, status, reviewed_by, reviewed_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'approved' THEN $7::uuid END,
             CASE WHEN $6 = 'approved' THEN now() END, $1)`,
    [ids[t.person], await typeId(t.type), t.start, t.end, t.note, t.status, ids.alex],
  );
}

// Demo emails are already "delivered" so nothing gets sent to example.com.
await db.query(`UPDATE notifications SET status = 'sent', sent_at = now() WHERE status = 'queued'`);

console.log(`Demo data loaded (time zone ${timezone}).

  Admin:   admin@example.com / ${PASSWORD}
  Members: jordan@, priya@, sam@, maria@, taylor@, chris@, dana@, morgan@, riley@example.com / ${PASSWORD}
`);
await db.end();
