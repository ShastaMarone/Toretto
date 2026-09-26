# Toretto — team shift scheduling

A "When I Work"–style scheduling app for tiered teams. Every tier works from
one calendar that's always there: admins add shifts as **drafts**, **publish**
when they're ready, and everyone affected gets an **email with a Confirm
button**. Team members sign in with their email to see **My Schedule** and the
**Team Schedule** (every tier, so they know who's working), confirm shifts, and
request time off (paid holiday, personal day, vacation, …) by clicking a day.
Canadian statutory holidays show on every calendar, and there's a light and a
neon dark theme.

![Schedule builder, dark theme](docs/screenshots/schedule-builder.png)

<table>
  <tr>
    <td><img src="docs/screenshots/schedule-builder-light.png" alt="Schedule builder, light theme" /></td>
    <td><img src="docs/screenshots/team-schedule.png" alt="Team schedule" /></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/my-schedule.png" alt="My schedule" /></td>
    <td><img src="docs/screenshots/request-time-off.png" alt="Requesting time off" /></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/dashboard.png" alt="Admin dashboard" /></td>
    <td><img src="docs/screenshots/time-off-review.png" alt="Reviewing time-off requests" /></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/email-schedule-published.png" alt="Schedule email with confirm links" /></td>
    <td><img src="docs/screenshots/add-to-calendar.png" alt="Adding your shifts to Google Calendar" /></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/screenshots/mobile-my-schedule.png" alt="Mobile" width="260" /></td>
  </tr>
</table>

## What it does

**For admins**

- **Tiers** (Tier 1, 2, 3 — rename or add more). Everyone is scheduled on the same calendar, grouped by tier. Tier chips filter it down to one or more tiers.
- **Custom labels** such as On-Call, Training and Overtime, either for one tier's people or for everyone.
- **Schedule builder**: an open-ended calendar, with no dates to set up first. It shows a week, 2 weeks or a month as a people × days grid. Click **+** to add a shift, drag a shift to move it, and hold <kbd>Alt</kbd>/<kbd>Ctrl</kbd> while dragging to copy it. The builder:
  - suggests shift times already used on the schedule, and lets you type times ("3pm", "15:30") or pick them from a list that shows each shift's length
  - rejects overlapping shifts, including across schedules
  - flags anyone on time off that day
  - shows statutory holidays
  - can copy last week (or the 2 weeks before) forward as drafts
- **Repeating shifts**. When adding a shift, choose **Repeats** (every weekday, every day, weekly, or custom days) and an end date, and optionally skip statutory holidays. Each day becomes its own shift, so a single day can still be changed at the last minute. Days the person already works, or has approved time off, are skipped and listed.
- **More schedules if you need them**. The **Main schedule** is always there. Add others (holiday coverage, a project, a second site) from the schedule's name menu. Each one covers every tier, and the team sees all of them together.
- **Draft → Publish**. Drafts are invisible to the team. **Publish** the days you're looking at, or every change at once. Publishing emails every affected person **once**, with all their shifts and a Confirm link for each one.
- **Edit after publishing**. The team keeps seeing the published version until you publish again. Then only the people affected get an email ("new", "changed" with the old time struck through, "cancelled"). Changed shifts need to be confirmed again. You can **Discard** unpublished changes to go back to the published version.
- **Confirmation tracking**: every shift shows ◷ pending or ✓ confirmed. The dashboard shows confirmations week by week and who hasn't confirmed, and an automatic reminder email goes out after 24 hours (configurable).
- **Admin emails** when someone requests (or cancels) time off and when someone confirms shifts. Each admin can turn either off in their profile.
- **Time-off approvals**: approve or decline, with a warning when the request overlaps scheduled shifts. You can also record time off for someone directly.
- **Canadian statutory holidays** on every calendar, including the weekday a weekend holiday is observed. The default is the federal list (Canada Labour Code); pick a province or territory, or turn holidays off, in **Settings**.
- **People**: invite by email, one at a time or in bulk. Set each person's role, tier and team, deactivate, or re-send invites.
- **Activity**: an audit trail (who published, confirmed, approved and when) plus a log of every email with its delivery status, a preview, and retry for failures. The email log keeps emails for 90 days by default (30 days to a year, or forever, in **Settings**); the audit trail is always kept.

**For team members**

- Join from an emailed link: an admin invites you (or you sign up yourself, if your admin turned that on). The link confirms your email address and lets you choose a password.
- Sign in with email + password, or **"Email me a sign-in link"** (no password needed).
- **My Schedule**: a month calendar, shifts waiting for confirmation (confirm one or all), the next two weeks, and your time-off requests.
- **Request time off** by clicking any day. Pick a type (Paid Holiday, Personal Day, Vacation, Sick Day, Unpaid Leave — admins can edit the list) and a date range. You're warned if you're scheduled during that time.
- **Team Schedule**: everyone's published shifts across every tier (week, 2 weeks or month), filterable by tier, team and schedule. Coworkers see that someone is off, not why.
- **Google Calendar**: **Add to calendar** on My Schedule (or **Calendar** in your profile) creates a private link to your published shifts and approved time off, and **Add to Google Calendar** subscribes to it. Outlook, Apple Calendar and other apps can subscribe to the same link. Google Calendar checks for changes every few hours, so an update can take up to a day to show there. **Get a new link** replaces a link that was shared by mistake. See [Calendar feeds](#calendar-feeds).
- **Light, dark or system theme**, with frosted-glass panels and neon glows in the dark theme. Saved per device.
- Works on phones. The calendars switch to a compact dot view and a day-by-day agenda.
- Times are shown in each person's own time zone, in the app and in emails, as 12-hour ("3:00 PM") or 24-hour ("15:00") times. The organization sets the default; anyone can pick their own in their profile.

## Quick start (local)

You need **Node.js 22** (22.13 or later) and **PostgreSQL 14+** (or Docker).

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
  organization and first admin. You then get an email (in the dev mailbox, below)
  to confirm your address and choose your password.

In development, emails aren't sent. Every email the app would send (invites,
confirmation links, schedule emails) appears in the **dev mailbox** at
**http://localhost:5173/dev/mailbox**, so you can click the links.

## Configuration

All settings are environment variables (see [`.env.example`](.env.example)).
Organization name, time zone, week start, 12/24-hour time format, statutory
holiday region, reminder timing and sign-up policy are changed in the app under
**Settings**.

| Variable                                            | Default                                   | Purpose                                                                                                                             |
| --------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `APP_URL`                                           | `http://localhost:5173`                   | Public URL of the app, used for links in emails. **Required in production** (on Vercel it defaults to the production URL).          |
| `DATABASE_URL`                                      | local `toretto` DB                        | PostgreSQL connection string (add `?sslmode=require` if your host needs SSL). `POSTGRES_URL` works too. **Required in production.** |
| `PORT`                                              | `3001`                                    | HTTP port.                                                                                                                          |
| `ADMIN_EMAIL`                                       | —                                         | Only this address may complete the first-run setup page. **Set this before your first production start.**                           |
| `EMAIL_TRANSPORT`                                   | `console`                                 | `console` (log + dev mailbox), `smtp`, `postmark` or `sendgrid`.                                                                    |
| `EMAIL_FROM`                                        | `Toretto Scheduling <no-reply@localhost>` | Sender, e.g. `Scheduling <scheduling@yourcompany.com>`.                                                                             |
| `SMTP_URL`                                          | —                                         | For `smtp`: `smtp://user:pass@host:587`.                                                                                            |
| `POSTMARK_SERVER_TOKEN` / `POSTMARK_MESSAGE_STREAM` | — / `outbound`                            | For `postmark`.                                                                                                                     |
| `SENDGRID_API_KEY`                                  | —                                         | For `sendgrid`.                                                                                                                     |
| `RUN_WORKER`                                        | `true`                                    | Send emails from the web process. Set `false` if you run `npm run worker` separately.                                               |
| `CRON_SECRET`                                       | —                                         | On Vercel: turns on `GET /api/cron` (reminders, email retries) for Vercel Cron, which sends it as a bearer token. 16+ characters.   |
| `TRUST_PROXY`                                       | `0` (`1` on Vercel)                       | Set to `1` behind a load balancer (Render, Railway, Fly, Heroku) so rate limiting sees real client IPs.                             |
| `NODE_ENV`                                          | `development`                             | Use `production` in production (the Docker image already does).                                                                     |

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

You need PostgreSQL, plus either one long-running Node.js process (Docker,
Render, Railway, Fly.io, any server) or Vercel. Database migrations run
automatically on start.

### Docker, Render, Railway, Fly.io

The server is one process that serves both the API and the web app.

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

### Vercel

The repository deploys to Vercel as is. `vercel.json` builds it with
`npm run build:vercel`, which serves the web app from Vercel's CDN and runs all
of `/api` as one Node.js function (`server/src/vercel.ts`). It overrides any
framework preset chosen in the dashboard.

1. Import the repository in Vercel (or redeploy an existing project).
2. Add a database: **Storage → Create Database → Neon** (or any PostgreSQL
   host), connected to the project. This adds `DATABASE_URL` (or
   `POSTGRES_URL`); the pooled connection string is fine. Pick the region
   closest to your functions (Vercel's default is Washington, D.C., AWS
   `us-east-1`).
3. Under **Settings → Environment Variables**, add:
   - `ADMIN_EMAIL`: the address allowed to create the first admin account.
   - `EMAIL_TRANSPORT`, your provider's key and `EMAIL_FROM` (see
     [Email delivery](#email-delivery)).
   - `CRON_SECRET`: a random string of 16 or more characters, e.g. from
     `openssl rand -hex 32`. Vercel sends it with its cron calls.
   - `APP_URL`, only for a custom domain. Otherwise links in emails use the
     project's production URL.
4. Redeploy, because settings only apply to new deployments. Then open the
   production URL and complete the setup page.

Until email is set up, emails are only written to the function logs (the
project's **Logs** tab), and the app says so. You can copy the setup link from
there. Or create the admin from your computer instead:
`DATABASE_URL="…" npm run create-admin -- --email you@yourcompany.com --name "Your Name" --password "…"`.

Without a server process running between requests:

- Emails are sent right after the request that queued them.
- Reminders and email retries run on later requests, at most once a minute per
  function instance. They also run once a day at 14:00 UTC, when Vercel Cron
  calls `/api/cron` (the Hobby plan allows one run a day). On Pro you can run it
  more often by changing the schedule in `server/build-vercel.mjs`.
- Rate limits are counted per function instance, so they're looser than on a
  single server. The [Vercel Firewall](https://vercel.com/docs/vercel-firewall)
  can add stricter ones.
- Preview deployments sit behind Vercel's login by default, so teammates can't
  open links to them. Give the team the production URL.

### The first admin

Create the first admin in one of two ways:

1. Open the app and complete the **setup page**. It only accepts the `ADMIN_EMAIL` address,
   and emails that address a link to choose the admin password.
2. Or run it from the command line:
   ```bash
   node dist/server/create-admin.js --email you@yourcompany.com --name "Your Name"
   ```
   (`npm run create-admin -- …` in development.) This prints a link for setting
   a password; add `--password "…"` to set one directly. Running it for an
   existing person promotes them to admin.

After that, invite your team from **People**. If you'd rather let people join
themselves, turn on self sign-up under **Settings**, optionally limited to your
company's email domain. They get an email to confirm their address and choose
a password, then an admin assigns their tier.

> Development conveniences (the dev mailbox, and a setup page open to anyone)
> only switch on when `APP_URL` is a `localhost` address and `NODE_ENV` isn't
> `production`. So a public deployment stays locked down even if `NODE_ENV` is
> forgotten.

## How it works

### Data model

The tables follow the playbook, with a few additions (✚) the features need:

| Table                                     | Purpose                                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                                   | name, email, role (`admin`/`member`), `tier_id`, `team_id`, personal time zone and 12/24-hour format ✚, admin email preferences ✚, email-confirmed/deactivated timestamps ✚ |
| `tiers`, `teams`                          | Tier 1/2/3 (renameable, colored) and optional teams                                                                                                                         |
| `labels`                                  | admin-defined shift labels; `tier_id` = only for that tier's people, `NULL` = everyone                                                                                      |
| `schedules`                               | a named, open-ended calendar for every tier; the **main schedule** (`is_default`) always exists                                                                             |
| `shifts`                                  | person, label, start/end, notes, `status` pending/confirmed — plus a **published snapshot** ✚ (see below)                                                                   |
| `time_off_types` ✚, `time_off_requests` ✚ | Paid Holiday, Personal Day, …; requests with pending/approved/declined/cancelled                                                                                            |
| `notifications`                           | the email outbox and notification log (recipient, kind, status, attempts, sent time, related shifts)                                                                        |
| `audit_log` ✚                             | who did what, when                                                                                                                                                          |
| `sessions` ✚, `auth_tokens` ✚             | sign-in sessions and single-use email links, stored as SHA-256 hashes                                                                                                       |
| `org_settings` ✚                          | organization name, time zone, week start, time format, holiday region, reminder delay, sign-up policy                                                                       |

### Publish → notify → confirm

Each shift row holds two copies of its data:

- the **working copy**, which admins edit in the builder;
- the **published snapshot**, which is what the team sees.

Publishing compares the two for every shift in the chosen dates (the days on
screen) or, with **Publish all changes**, on the whole schedule. A shift counts
as in the dates if either its working copy or its published version is:

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
confirms every shift listed in it. Admins who want to know get one email per
confirmation (or per "confirm all"), never for their own shifts.

A shift's tier is its person's tier, so moving someone to another tier moves
their shifts with them. Holidays are computed in the app (`shared/holidays.ts`)
rather than stored, and are for information only: you can still schedule people
on a holiday.

### Time zones

Timestamps are stored in UTC. Schedules are built in the organization's time
zone (Settings). Each person can pick their own zone (Profile), and their views
and emails use it. Moving or copying a shift keeps its wall-clock times, even
across daylight-saving changes.

### Calendar feeds

Each person's link is `APP_URL/api/calendar/<secret>.ics`: an iCalendar feed
of their published shifts (never drafts) from 90 days ago to a year ahead,
and their approved time off as all-day events. Calendar apps fetch it without
signing in, so the secret in the link is what protects it. It stops working
when the person turns it off, gets a new link, or is deactivated. Unlike
sign-in tokens, it's stored as-is (so the profile can show it again); it only
gives read access to shifts that are already in the same database.

Google Calendar fetches feeds from Google's servers, so for **Add to Google
Calendar** to work:

- The app must be reachable from the internet over **https** at `APP_URL`. A
  server that's only on the company network or VPN can't be reached by Google.
- `robots.txt` must keep allowing `/api/calendar/`: Google Calendar checks it
  before fetching. The one that ships blocks search engines from everything
  else.
- Google decides how often to check for changes (every few hours, up to about
  a day), and there's no way to make it check sooner. Outlook and Apple
  Calendar check hourly.

### Security

- Passwords are hashed with scrypt, and are only ever chosen from a link
  emailed to the address (invite, sign-up confirmation or reset). Nobody can
  pre-register someone else's email with a password they know.
- Correcting an unconfirmed person's email address cancels every link and
  session tied to the old address.
- Sessions use a server-side, httpOnly, SameSite cookie. Changing a password
  signs out other devices.
- Email links are single-use, expire, and are stored hashed.
- Calendar feed links are 256-bit random secrets. Each one shows only its
  owner's published shifts and approved time off, and can be replaced or
  turned off at any time.
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
| Labels global or per tier?        | **Both.** Each label belongs to one tier (only for its people) or to everyone.                                         |
| Reminders for unconfirmed shifts? | **Yes.** One reminder per shift after 24 h (Settings: off / 12 h / 24 h / 2 days / 3 days).                            |
| Shift swaps/trades?               | **Out of scope for v1.** People contact their admin, who edits and re-publishes. Only the affected people are emailed. |
| Multiple time zones?              | **Supported.** Schedules are built in the organization's zone; each person sees their own.                             |
| One schedule per tier?            | **No.** One calendar for every tier, with extra schedules only when you want a separate roster.                        |
| Repeating shifts as a series?     | **No.** Repeating creates separate shifts, so any one day can change without "this or all?" questions.                 |
| Statutory holidays?               | **Canadian**, federal by default or any province/territory. Shown on calendars; they don't block scheduling.           |

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
npm run test:e2e:vercel   # the same, against the Vercel build output
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
shared/            types, time and holiday helpers shared by server and web
web/src/
  pages/           admin/, member/, auth/ screens
  components/      schedule grid pieces, dialogs, UI kit
e2e/               Playwright end-to-end test
```

## Ideas for later

- Shift swaps and open shifts that people can pick up
- SMS or push notifications
- Partial-day time off and time-off balances
- Shift templates and availability preferences
- Reporting on hours per person
