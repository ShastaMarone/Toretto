# Toretto on Google Apps Script

The same scheduling app, with the same screens and features, running entirely
on Google instead of a server and database:

- a **Google Sheet** holds the data (one tab per kind of thing: people, shifts, time off, …)
- **Gmail** sends the emails, from the Google account that sets it up
- people **sign in with their Google account**, so there are no passwords

Admins and team members work exactly as in the other version. Only people an
admin adds on the **People** page can open the schedule, and only admins can
change it. Everyone else sees "You're not on the schedule yet. Ask an admin to
add you."

You need a **Google Workspace account** (a work Google account). With a
personal Gmail account, Google doesn't tell the app who's visiting, so nobody
but you could sign in.

## Set it up (about 10 minutes)

The three files to copy are in [`apps-script/build`](build). On GitHub, open
each one and use the **Copy raw file** button at the top right of the file (or
open **Raw**, select all and copy). They're big (`Code.gs` is about 800 KB), so
pasting takes a few seconds.

1. **Create a Google Sheet** for the data, for example "Team schedule". A
   Shared Drive is best, so it stays with the team if you move on.
2. In the Sheet, choose **Extensions → Apps Script**. The script editor opens
   with a file called `Code.gs`.
3. **Code.gs**: select everything in it, delete it, and paste
   [`build/Code.gs`](build/Code.gs).
4. **index.html**: next to **Files**, click **+ → HTML**, name it `index` (the
   editor adds `.html`), and replace what's in it with
   [`build/index.html`](build/index.html).
5. **appsscript.json**: click **Project Settings** (the gear on the left),
   tick **Show "appsscript.json" manifest file in editor**, go back to the
   **Editor**, open `appsscript.json`, and replace what's in it with
   [`build/appsscript.json`](build/appsscript.json).
6. Click **Save** (the disk icon, or Ctrl+S).
7. **Run setup**: pick `setup` in the function menu in the toolbar (next to
   **Debug**) and click **Run**. Google asks for permission: **Review
   permissions**, choose your account, then **Allow**. (If it says "Google
   hasn't verified this app", click **Advanced → Go to …**. It's your own
   script.) The log at the bottom should end with
   "Setup done (version …) … Time zones check out."

   Setup adds the tabs to the Sheet, the Main schedule, the time-off types and
   starter tiers, makes **you** the first admin, and starts the timed jobs
   (emails, reminders and tidying up). It's safe to run again.

8. **Deploy it**: click **Deploy → New deployment**, click the gear next to
   **Select type** and choose **Web app**. Set:
   - **Execute as**: Me
   - **Who has access**: Anyone within your organization

   Click **Deploy** and copy the **Web app URL** (it ends in `/exec`). That's
   the link for your team.

9. **Open the link yourself** once. That's how the app learns its address for
   the links in emails. You'll land on the admin dashboard.
10. **Add your team** on the **People** page. Each person gets an email with the
    link and signs in with their Google account. To make someone else an
    admin, set their role to Admin.

In **Settings** you can rename the organization (it's also the name emails
come from), change the time zone (Toronto by default), and choose the
statutory holidays. **Let people join by opening the app** lets anyone in your
organization join as a team member without an invite (you can limit it to
certain email domains).

## Updating to a new version

1. Copy **all three files** from [`apps-script/build`](build) again, as in steps
   3 to 5. `Code.gs` and `index.html` must come from the same version. If they
   don't, the app shows a "needs a quick fix" page instead of the schedule.
   The version is on the first line of `Code.gs`.
2. Save, and run `setup` again. It adds anything the new version needs to the
   Sheet.
3. Click **Deploy → Manage deployments**, click the pencil, set **Version** to
   **New version**, and click **Deploy**. The link stays the same.

## If something's not working

- **"Almost there: run setup"**: run `setup` (step 7), then reload the page.
- **"Can't reach the scheduling server"**: the line under it says what went
  wrong. "Authorization is required" means Google wants your permission
  again: run `setup` and allow it. For anything else, send a screenshot of the
  message to whoever maintains the app.
- **"This schedule app needs a quick fix"**: `Code.gs` and `index.html` come
  from different versions. Copy both again.
- **Executions** (the list icon on the left of the Apps Script editor) lists
  every run with its log, including errors.
- The **Test deployments** link (it ends in `/dev`) only works for people who
  can edit the script, and always runs the latest saved code, which is handy
  for checking an update before you deploy it. Your team uses the `/exec` link
  from step 8.

## Good to know

- **Don't share the Sheet with the team.** The team only needs the web app
  link. Anyone who can edit the Sheet can edit the data (including who's an
  admin) and the app itself, and anyone who can view it can read everyone's
  schedule and emails. Share it only with whoever maintains the app.
- **Don't edit the Sheet by hand.** Make every change in the app. The Sheet is
  the app's database, and sorting, retyping or deleting cells can break it.
  Looking is fine. For a backup, use **File → Make a copy**; **File → Version
  history** can undo mistakes.
- **Emails** come from your Gmail address, named after your organization, and
  replies go to your inbox. Google Workspace lets a script email about 1,500
  people a day. Past that, emails wait and go out the next day. They're
  usually sent within seconds, or at most 5 minutes later. Reminders go out
  hourly. **Activity → Email log** shows every email and whether it was sent.
- **Speed**: each change takes a second or two, since the data lives in a
  Sheet. That's fine for a team's schedule. For hundreds of people, the
  Vercel version is quicker.
- **Not in this version**: the Google Calendar feed ("Add to calendar"),
  passwords and email sign-in links (Google handles sign-in), and the Sign out
  button.
- **If you move on**: the app and its timed jobs run as the person who
  deployed them. Someone else who can edit the Sheet should open
  **Extensions → Apps Script**, run `setup`, and make a new deployment as
  themselves. Then the team needs the new link.

## Try it on your computer

With Node.js 22 and this repository:

```bash
npm install
npm run build:apps-script     # writes apps-script/build/
npm run preview:apps-script   # http://localhost:4400
```

The preview runs the built files with a pretend Google Sheet and Gmail, and
demo people and shifts, and saves nothing. You're signed in as the admin. Add
`?as=priya@example.com` to the address to be a team member, and see the
emails it would have sent at http://localhost:4400/mail.

## For developers

```
apps-script/
  src/          the server: the API on a Google Sheet (see src/db/store.ts),
                Gmail, timed jobs, and doGet for the page
  client/       the page's entry point and an API client that calls
                google.script.run; the screens themselves are web/src
  build.mjs     builds build/Code.gs (esbuild) and build/index.html (Vite,
                everything inlined)
  build/        the files to paste into Apps Script (committed; CI checks
                they're current)
  test/         API tests against an emulator of the Apps Script services
  e2e/          browser test against the preview
  preview.ts    the local preview
```

- The screens, the shared rules in `shared/`, the email templates and the
  request validation are the same code as the Vercel version. The services in
  `src/services` follow `server/src/services` one to one, synchronously, over
  the Sheet instead of Postgres. Changes need the script lock, and a request
  that fails saves nothing, like a rolled-back transaction.
- The server tells the page it uses Google sign-in (`signIn: 'google'` in
  `/bootstrap`). That's what hides passwords, Sign out and the calendar feed
  in the shared screens.
- `SCHEMA_VERSION` in `src/main.ts`: bump it when you add a tab or column in
  `src/db/schema.ts`. The next change adds them to the Sheet.
- After changing `web/src`, `shared`, the email templates or `apps-script`,
  run `npm run build:apps-script` and commit `apps-script/build`. CI fails if
  it's out of date.
- Tests: `npx vitest run --project apps-script` (part of `npm test`), and
  `npm run test:e2e:apps-script`.
- With [clasp](https://github.com/google/clasp), push `apps-script/build`
  (`rootDir` in `.clasp.json`) instead of copying by hand.
