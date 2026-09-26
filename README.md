# Toretto — team shift scheduling

A "When I Work"–style scheduling app for tiered teams. Admins build each tier's
schedule as a **draft**, **publish** it when it's ready, and everyone with a
shift gets an **email with a Confirm button**. Team members sign in with their
email to see **My Schedule** and the **Team Schedule**, confirm shifts, and
request time off (paid holiday, personal day, vacation, …) by clicking a day.

![Schedule builder](docs/screenshots/schedule-builder.png)

<table>
  <tr>
    <td><img src="docs/screenshots/my-schedule.png" alt="My schedule" /></td>
    <td><img src="docs/screenshots/team-schedule.png" alt="Team schedule" /></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/request-time-off.png" alt="Requesting time off" /></td>
    <td><img src="docs/screenshots/dashboard.png" alt="Admin dashboard" /></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/email-schedule-published.png" alt="Schedule email with confirm links" /></td>
    <td align="center"><img src="docs/screenshots/mobile-my-schedule.png" alt="Mobile" width="260" /></td>
  </tr>
</table>

## What it does

**For admins**

- **Tiers** (Tier 1, 2, 3 — rename or add more), each with its own schedules.
- **Custom labels** such as On-Call, Training and Overtime, either for one tier or for every tier.
- **Schedule builder**: a people × days grid. Click **+** to add a shift, drag a shift to move it, and hold <kbd>Alt</kbd>/<kbd>Ctrl</kbd> while dragging to copy it. The builder:
  - suggests shift times already used in the schedule
  - rejects overlapping shifts
  - flags anyone on time off that day
  - can start a new schedule by copying a previous one
- **Draft → Publish**. Drafts are invisible to the team. Publishing emails every affected person **once**, with all their shifts and a Confirm link for each one.
- **Edit after publishing**. The team keeps seeing the published version until you **Publish changes**. Then only the people affected get an email ("new", "changed" with the old time struck through, "cancelled"). Changed shifts need to be confirmed again. You can **Discard changes** to go back to the published version.
- **Confirmation tracking**: every shift shows ◷ pending or ✓ confirmed. The dashboard shows who hasn't confirmed, and an automatic reminder email goes out after 24 hours (configurable).
- **Time-off approvals**: approve or decline, with a warning when the request overlaps scheduled shifts. You can also record time off for someone directly.
- **People**: invite by email, one at a time or in bulk. Set each person's role, tier and team, deactivate, or re-send invites.
- **Activity**: an audit trail (who published, confirmed, approved and when) plus a log of every email with its delivery status, a preview, and retry for failures.

**For team members**

- Sign in with email + password, or **"Email me a sign-in link"** (no password needed).
- **My Schedule**: a month calendar, shifts waiting for confirmation (confirm one or all), the next two weeks, and your time-off requests.
- **Request time off** by clicking any day. Pick a type (Paid Holiday, Personal Day, Vacation, Sick Day, Unpaid Leave — admins can edit the list) and a date range. You're warned if you're scheduled during that time.
- **Team Schedule**: everyone's published shifts for the week, filterable by tier and team. Coworkers see that someone is off, not why.
- Works on phones. The calendars switch to a compact dot view and a day-by-day agenda.
- Times are shown in each person's own time zone, in the app and in emails.

## Quick start (local)

You need **Node.js 22.22+** and **PostgreSQL 14+** (or Docker).

```bash
npm install
cp .env.example .env
docker compose up -d --wait db # or use any Postgres; set DATABASE_URL in .env
npm run seed                   # optional: demo team, schedules and time off
npm run dev                    # API on :3001, web app on http://localhost:5173
```

Open **http://localhost:5173**.

- **With demo data**, sign in as `admin@example.com` / `password123` (admin) or
  `sam@example.com` / `password123` (team member). Other members are `jordan@`,
  `priya@`, `maria@`, `taylor@`, `chris@`, `dana@`, `morgan@` and `riley@example.com`,
  all with the same password.
- **Without demo data**, you land on the **setup page** to create your
  organization and first admin.

In development, emails aren't sent. Every email the app would send (invites,
confirmation links, schedule emails) appears in the **dev mailbox** at
**http://localhost:5173/dev/mailbox**, so you can click the links.

## Configuration

All settings are environment variables (see [`.env.example`](.env.example)).
Organization name, time zone, week start, reminder timing and sign-up policy are
changed in the app under **Settings**.

| Variable                                            | Default                                   | Purpose                                                                                                   |
| --------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `APP_URL`                                           | `http://localhost:5173`                   | Public URL of the app, used for links in emails. **Required in production.**                              |
| `DATABASE_URL`                                      | local `toretto` DB                        | PostgreSQL connection string (add `?sslmode=require` if your host needs SSL). **Required in production.** |
| `PORT`                                              | `3001`                                    | HTTP port.                                                                                                |
| `ADMIN_EMAIL`                                       | —                                         | Only this address may complete the first-run setup page. **Set this before your first production start.** |
| `EMAIL_TRANSPORT`                                   | `console`                                 | `console` (log + dev mailbox), `smtp`, `postmark` or `sendgrid`.                                          |
| `EMAIL_FROM`                                        | `Toretto Scheduling <no-reply@localhost>` | Sender, e.g. `Scheduling <scheduling@yourcompany.com>`.                                                   |
| `SMTP_URL`                                          | —                                         | For `smtp`: `smtp://user:pass@host:587`.                                                                  |
| `POSTMARK_SERVER_TOKEN` / `POSTMARK_MESSAGE_STREAM` | — / `outbound`                            | For `postmark`.                                                                                           |
| `SENDGRID_API_KEY`                                  | —                                         | For `sendgrid`.                                                                                           |
| `RUN_WORKER`                                        | `true`                                    | Send emails from the web process. Set `false` if you run `npm run worker` separately.                     |
| `TRUST_PROXY`                                       | `0`                                       | Set to `1` behind a load balancer (Render, Railway, Fly, Heroku) so rate limiting sees real client IPs.   |
| `NODE_ENV`                                          | `development`                             | Use `production` in production (the Docker image already does).                                           |

### Email delivery

Pick a transactional email provider and verify your sending domain there (SPF
and DKIM). This keeps confirmation emails out of spam folders.

- **Postmark**: `EMAIL_TRANSPORT=postmark`, `POSTMARK_SERVER_TOKEN=…`
- **SendGrid**: `EMAIL_TRANSPORT=sendgrid`, `SENDGRID_API_KEY=…`
- **Any SMTP relay** (Microsoft 365, Google Workspace, Mailgun, Amazon SES…): `EMAIL_TRANSPORT=smtp`,
  `SMTP_URL=smtp://user:password@smtp.example.com:587`

Link tracking is turned off for Postmark and SendGrid so sign-in and confirm
links aren't rewritten.

The Microsoft 365 / Outlook link scanner can open links before people do. So
confirm-email and sign-in links open a page with a button, instead of acting
the moment the link is fetched. Shift-confirm links require the person to be
signed in.

Emails are queued in the database and sent in the background, with retries at
1, 5, 15 and 60 minutes. Failures show up under **Activity → Email log**, where
you can retry them.

## Deploying

The app is one Node.js process plus PostgreSQL. It runs database migrations
automatically on start and serves both the API and the web app.

**Docker (any host):**

```bash
docker build -t toretto .
docker run -p 3000:3000 \
  -e APP_URL=https://schedule.yourcompany.com \
  -e DATABASE_URL=postgres://… \
  -e ADMIN_EMAIL=you@yourcompany.com \
  -e EMAIL_TRANSPORT=postmark -e POSTMARK_SERVER_TOKEN=… \
  -e EMAIL_FROM="Scheduling <scheduling@yourcompany.com>" \
  -e TRUST_PROXY=1 \
  toretto
```

**Render / Railway / Fly.io:** create a PostgreSQL database and a web service
from this repository's `Dockerfile`, then set the variables above. Use
`/api/health` as the health check path.

**Without Docker:**

```bash
npm ci && npm run build
NODE_ENV=production node dist/server/index.js
```

Then create the first admin in one of two ways:

1. Open the app and complete the **setup page**. It only accepts the `ADMIN_EMAIL` address.
2. Or run it from the command line:
   ```bash
   node dist/server/create-admin.js --email you@yourcompany.com --name "Your Name"
   ```
   (`npm run create-admin -- …` in development.) This prints a link for setting
   a password; add `--password "…"` to set one directly. Running it for an
   existing person promotes them to admin.

After that, invite your team from **People**. If you'd rather let people join
themselves, turn on self sign-up under **Settings**, optionally limited to your
company's email domain. They confirm their email, then an admin assigns their
tier.

> Development conveniences (the dev mailbox, and a setup page open to anyone)
> only switch on when `APP_URL` is a `localhost` address and `NODE_ENV` isn't
> `production`. So a public deployment stays locked down even if `NODE_ENV` is
> forgotten.

## How it works

### Data model

The tables follow the playbook, with a few additions (✚) the features need:

| Table                                     | Purpose                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `users`                                   | name, email, role (`admin`/`member`), `tier_id`, `team_id`, personal time zone ✚, email-confirmed/deactivated timestamps ✚ |
| `tiers`, `teams`                          | Tier 1/2/3 (renameable, colored) and optional teams                                                                        |
| `labels`                                  | admin-defined shift labels; `tier_id` = one tier, `NULL` = all tiers                                                       |
| `schedules`                               | one tier's roster for a date range (≤ 6 weeks), `status` draft/published                                                   |
| `shifts`                                  | person, label, start/end, notes, `status` pending/confirmed — plus a **published snapshot** ✚ (see below)                  |
| `time_off_types` ✚, `time_off_requests` ✚ | Paid Holiday, Personal Day, …; requests with pending/approved/declined/cancelled                                           |
| `notifications`                           | the email outbox and notification log (recipient, kind, status, attempts, sent time, related shifts)                       |
| `audit_log` ✚                             | who did what, when                                                                                                         |
| `sessions` ✚, `auth_tokens` ✚             | sign-in sessions and single-use email links, stored as SHA-256 hashes                                                      |
| `org_settings` ✚                          | organization name, time zone, week start, reminder delay, sign-up policy                                                   |

### Publish → notify → confirm

Each shift row holds two copies of its data:

- the **working copy**, which admins edit in the builder;
- the **published snapshot**, which is what the team sees.

Publishing compares the two for every shift in the schedule:

| Working copy vs. published    | What happens                         | Email                                 |
| ----------------------------- | ------------------------------------ | ------------------------------------- |
| never published               | becomes visible, status _pending_    | "New shift" + Confirm link            |
| time, person or label changed | snapshot updated, back to _pending_  | "Changed: was … now …" + Confirm link |
| only the note changed         | snapshot updated, confirmation kept  | "Changed" (no re-confirm needed)      |
| deleted by the admin          | removed from the team's view         | "Cancelled"                           |
| reassigned to someone else    | cancelled for one, new for the other | both people                           |
| unchanged                     | nothing                              | none                                  |

Each person gets **one** email per publish, covering all their changes. Shifts
that have already ended are left out, and people with no upcoming changes get
nothing. Emails are queued inside the same database transaction as the publish,
so a failure in either rolls back both. Delivery happens in the background, so
the Publish button never waits on the email provider.

Clicking **Confirm** in the email opens `/confirm-shift/:id`. If the person
isn't signed in, they sign in first and are brought straight back. The shift is
marked confirmed, and they land on **My Schedule**. **Confirm all** in the email
confirms every shift of theirs in that schedule.

### Time zones

Timestamps are stored in UTC. Schedules are built in the organization's time
zone (Settings). Each person can pick their own zone (Profile), and their views
and emails use it. Moving or copying a shift keeps its wall-clock times, even
across daylight-saving changes.

### Security

- Passwords are hashed with scrypt.
- Sessions use a server-side, httpOnly, SameSite cookie. Changing a password
  signs out other devices.
- Email links are single-use, expire, and are stored hashed.
- Sign-in, sign-up and password-reset responses never reveal whether an email
  has an account.
- Auth endpoints are rate limited, and cross-site requests are rejected.
- Emails escape all user content.
- In production, a Content-Security-Policy and other security headers are set.
- Email bodies that contain sign-in links are hidden from admins in the email
  log.

## Decisions on the playbook's open questions

| Question                          | Decision                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Labels global or per tier?        | **Both.** Each label belongs to one tier or to all tiers.                                                              |
| Reminders for unconfirmed shifts? | **Yes.** One reminder per shift after 24 h (Settings: off / 12 h / 24 h / 2 days / 3 days).                            |
| Shift swaps/trades?               | **Out of scope for v1.** People contact their admin, who edits and re-publishes. Only the affected people are emailed. |
| Multiple time zones?              | **Supported.** Schedules are built in the organization's zone; each person sees their own.                             |

Other choices worth knowing:

- Time off is requested by the member and **approved by an admin**.
- Time off is **whole days only**.
- Team members **can't decline** a shift in the app. They confirm, or talk to
  their admin.

## Development

```bash
npm run dev          # API (tsx watch) + web (Vite) with hot reload
npm test             # unit + API integration tests (needs Postgres; see below)
npm run test:e2e     # builds, then drives the whole flow in Chromium (Playwright;
                     # first time: npx playwright install chromium)
npm run lint         # ESLint
npm run typecheck    # TypeScript (web + server)
npm run format       # Prettier
npm run seed -- --reset   # wipe and reload demo data
```

The tests use a real PostgreSQL database. They default to
`postgres://toretto:toretto@localhost:5432/toretto_test`; override with
`TEST_DATABASE_URL`. Each test file runs in its own schema. The e2e test uses
`toretto_e2e` (override with `E2E_DATABASE_URL`) and resets it on every run.
With `docker compose up -d db`, create the test database once:
`docker compose exec db createdb -U toretto toretto_test`.

**Stack:**

- React 19, React Router, TanStack Query, Tailwind CSS 4, Vite
- Express 5, PostgreSQL (`pg`), Zod, Luxon, Nodemailer
- Vitest, Supertest, Playwright

```
server/
  migrations/      SQL migrations (run automatically on start)
  src/
    routes/        REST API (auth, admin, schedules, member views, time off)
    services/      publish diff, schedules, shifts, time off, views
    email/         templates, transports, outbox worker (queue, retries, reminders)
    auth/          password hashing, sessions, email-link tokens, middleware
  scripts/         seed, create-admin, migrate
  test/            API integration tests
shared/            types and time helpers shared by server and web
web/src/
  pages/           admin/, member/, auth/ screens
  components/      schedule grid pieces, dialogs, UI kit
e2e/               Playwright end-to-end test
```

## Ideas for later

- Shift swaps and open shifts that people can pick up
- SMS or push notifications
- Calendar feeds (iCal) for Google/Outlook calendars
- Partial-day time off and time-off balances
- Shift templates and availability preferences
- Reporting on hours per person
