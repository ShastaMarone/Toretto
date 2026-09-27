import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';

// The core loop from the playbook, end to end in a real browser:
// setup → invite → build & publish → email → confirm → time off → approval.

interface MailboxMessage {
  toEmail: string;
  kind: string;
  subject: string;
  text: string;
}

async function waitForEmail(
  request: APIRequestContext,
  match: { to: string; kind: string },
): Promise<MailboxMessage> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = await request.get('/api/dev/mailbox');
    const messages = (await res.json()) as MailboxMessage[];
    const found = messages.find((m) => m.toEmail === match.to && m.kind === match.kind);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No ${match.kind} email for ${match.to}`);
}

function linkIn(email: MailboxMessage, path: string): string {
  const match = new RegExp(`https?://[^\\s]+${path}[^\\s]*`).exec(email.text);
  if (!match) throw new Error(`No ${path} link in "${email.subject}"`);
  return match[0];
}

/**
 * Passes only if the element is what's actually drawn at its center, i.e. not
 * cut off by a container's edge or covered by something else. (Playwright's
 * own checks can scroll a clipped container to reach it; a person can't.)
 */
async function expectOnTop(locator: Locator) {
  await expect
    .poll(() =>
      locator.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = el.ownerDocument.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit !== null && el.contains(hit);
      }),
    )
    .toBe(true);
}

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

test.describe.configure({ mode: 'serial' });

const ADMIN = { name: 'Robin Admin', email: 'robin@example.com', password: 'admin password 1' };
const MEMBER = { name: 'Priya Patel', email: 'priya@example.com', password: 'member password 1' };
const COWORKER = { name: 'Sam Chen', email: 'sam@example.com', password: 'coworker password 1' };

let admin: Page;
let member: Page;
let coworker: Page;

test.beforeAll(async ({ browser }) => {
  admin = await newPage(browser);
  member = await newPage(browser);
  coworker = await newPage(browser);
});

test('first admin sets up the workspace and confirms their email', async ({ request }) => {
  await admin.goto('/');
  await expect(admin).toHaveURL(/\/setup$/);
  await admin.getByLabel('Team or organization name').fill('Support Team');
  await admin.getByLabel('Your name').fill(ADMIN.name);
  await admin.getByLabel('Your email').fill(ADMIN.email);
  await admin.getByRole('button', { name: 'Create admin account' }).click();
  await expect(admin.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  // The password is chosen from the emailed link, which confirms the address.
  const verify = await waitForEmail(request, { to: ADMIN.email, kind: 'verify_email' });
  await admin.goto(linkIn(verify, '/set-password'));
  await expect(admin.getByRole('heading', { name: 'Welcome, Robin!' })).toBeVisible();
  await admin.getByLabel('New password').fill(ADMIN.password);
  await admin.getByLabel('Confirm password').fill(ADMIN.password);
  await admin.getByRole('button', { name: 'Set password & continue' }).click();
  await expect(admin).toHaveURL(/\/admin$/);
  await expect(
    admin.getByRole('heading', { name: /Good (morning|afternoon|evening), Robin/ }),
  ).toBeVisible();
});

test('admin invites a team member, who sets a password', async ({ request }) => {
  await admin.goto('/admin/people');
  await admin.getByRole('button', { name: 'Invite people' }).click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByLabel('Full name').fill(MEMBER.name);
  await dialog.getByLabel('Work email').fill(MEMBER.email);
  await dialog.getByLabel('Tier').selectOption({ label: 'Tier 1' });
  await dialog.getByRole('button', { name: 'Send invite' }).click();
  await expect(admin.getByText('Invite sent', { exact: true })).toBeVisible();

  // Row menus aren't cut off by the bottom of the list.
  await admin
    .getByRole('button', { name: /^Actions for / })
    .last()
    .click();
  await expectOnTop(admin.getByRole('menuitem', { name: 'Edit' }));
  await admin.keyboard.press('Escape');
  await expect(admin.getByRole('menu')).toHaveCount(0);

  const invite = await waitForEmail(request, { to: MEMBER.email, kind: 'invite' });
  expect(invite.subject).toBe('Robin Admin invited you to the Support Team schedule');
  await member.goto(linkIn(invite, '/set-password'));
  await expect(member.getByRole('heading', { name: 'Welcome, Priya!' })).toBeVisible();
  await member.getByLabel('New password').fill(MEMBER.password);
  await member.getByLabel('Confirm password').fill(MEMBER.password);
  await member.getByRole('button', { name: 'Set password & continue' }).click();
  await expect(member).toHaveURL(/\/my-schedule$/);
});

test('admin drafts a shift that the team cannot see until it is published', async () => {
  // One calendar for every tier, ready to go: no need to create a schedule first.
  await admin.goto('/admin/schedules');
  await expect(admin.getByRole('heading', { name: 'Main schedule' })).toBeVisible();
  // Next week, so the shift is still upcoming when it's published.
  await admin.getByRole('button', { name: 'Next', exact: true }).click();
  await admin
    .getByRole('button', { name: /^Add shift for Priya Patel on / })
    .first()
    .click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByRole('button', { name: 'On-Call' }).click();
  await dialog.getByRole('button', { name: 'Add shift', exact: true }).click();
  await expect(admin.getByRole('button', { name: /9am–5pm, On-Call, draft/ })).toBeVisible();
  await expect(admin.getByText('1 unpublished change this week')).toBeVisible();

  // Drafts are invisible to members.
  await member.goto('/team');
  await member.getByRole('button', { name: 'Next', exact: true }).click();
  const priya = member.getByRole('row', { name: /Priya Patel/ });
  await expect(priya).toBeVisible();
  await expect(member.getByText('9am–5pm')).toHaveCount(0);

  await admin.getByRole('button', { name: 'Publish 1 change' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Publish & notify' }).click();
  await expect(admin.getByText('Published', { exact: true })).toBeVisible();
  await expect(admin.getByRole('button', { name: 'All published' })).toBeDisabled();

  // Now the whole team sees it, whatever their tier.
  await member.reload();
  await expect(priya.getByText('9am–5pm')).toBeVisible();
});

test('the member confirms their shift from the email link', async ({ request }) => {
  const email = await waitForEmail(request, { to: MEMBER.email, kind: 'schedule_published' });
  expect(email.subject).toMatch(/^Your schedule for .+/);
  await member.goto(linkIn(email, '/confirm-shift/'));
  await expect(member).toHaveURL(/\/my-schedule$/);
  await expect(member.getByText('Shift confirmed — thanks!')).toBeVisible();
  await expect(member.getByText('waiting for your confirmation')).toHaveCount(0);
  const upcoming = member.getByRole('button', { name: /9:00 AM – 5:00 PM/ });
  await expect(upcoming).toBeVisible();
  await expect(upcoming.getByLabel('Confirmed')).toBeVisible();

  // Admins are emailed, and see it on the dashboard.
  const notice = await waitForEmail(request, { to: ADMIN.email, kind: 'shifts_confirmed' });
  expect(notice.subject).toMatch(/^Priya Patel confirmed their shift on /);
  await admin.goto('/admin');
  await expect(admin.getByText('1/1 confirmed')).toBeVisible();
});

test('calendars show statutory holidays, and dark mode sticks', async () => {
  await member.goto('/team?date=2026-12-25');
  await expect(
    member.getByRole('columnheader', { name: 'Friday, December 25, 2026' }),
  ).toContainText('Christmas Day');

  await member.getByRole('radio', { name: 'Dark' }).click();
  await expect(member.locator('html')).toHaveClass(/dark/);
  await member.reload();
  await expect(member.locator('html')).toHaveClass(/dark/);
  await member.getByRole('radio', { name: 'Light' }).click();
  await expect(member.locator('html')).not.toHaveClass(/dark/);
});

test('the member requests a personal day and the admin approves it', async ({ request }) => {
  await member.goto('/my-schedule');
  await member.getByRole('button', { name: 'Request time off' }).first().click();
  const dialog = member.getByRole('dialog');
  await dialog.getByText('Personal Day').click();
  await dialog.getByLabel('Note for your admin').fill('Appointment');
  await dialog.getByRole('button', { name: /^Request 1 day$/ }).click();
  await expect(member.getByText('Waiting for approval')).toBeVisible();

  const notice = await waitForEmail(request, { to: ADMIN.email, kind: 'time_off_requested' });
  expect(notice.subject).toContain('Priya Patel · Personal Day');

  await admin.goto('/admin/time-off');
  await expect(admin.getByText('“Appointment”')).toBeVisible();
  await admin.getByRole('button', { name: 'Approve' }).click();
  await expect(admin.getByText("Priya Patel's Personal Day approved")).toBeVisible();

  const decision = await waitForEmail(request, { to: MEMBER.email, kind: 'time_off_reviewed' });
  expect(decision.subject).toMatch(/^Your time off was approved: Personal Day/);
  await member.reload();
  await expect(member.getByText('Approved', { exact: true })).toBeVisible();
});

test('admin adds a shift that repeats Monday to Friday, typing the times', async () => {
  await admin.goto('/admin/schedules');
  // Two weeks out, where Priya has nothing yet.
  await admin.getByRole('button', { name: 'Next', exact: true }).click();
  await admin.getByRole('button', { name: 'Next', exact: true }).click();
  await admin.getByRole('button', { name: /^Add shift for Priya Patel on Mon,/ }).click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByLabel('Starts').fill('8am');
  await dialog.getByLabel('Starts').press('Enter');
  // "4" after an 8 AM start means 4 PM.
  await dialog.getByLabel('Ends').fill('4');
  await dialog.getByLabel('Ends').press('Enter');
  await expect(dialog.getByLabel('Ends')).toHaveValue('4:00 PM');
  await dialog.getByLabel('Repeats').selectOption('weekdays');
  await dialog.getByRole('button', { name: 'Add 5 shifts' }).click();
  await expect(admin.getByText('Added 5 shifts')).toBeVisible();
  // Five separate drafts, one per weekday.
  await expect(admin.getByRole('button', { name: /^8am–4pm, draft$/ })).toHaveCount(5);
});

test('people can switch to 24-hour times', async () => {
  await member.goto('/profile');
  await member.getByLabel('Time format').selectOption('24h');
  await member.getByRole('button', { name: 'Save changes' }).click();
  await expect(member.getByText('Profile saved')).toBeVisible();
  await member.goto('/team');
  await member.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(
    member.getByRole('row', { name: /Priya Patel/ }).getByText('09:00–17:00'),
  ).toBeVisible();
});

test('the member adds their shifts to Google Calendar', async ({ request }) => {
  await member.goto('/my-schedule');
  await member.getByRole('button', { name: 'Add to calendar' }).click();
  const dialog = member.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Create calendar link' }).click();
  const link = await dialog.getByLabel('Your calendar link').inputValue();
  expect(link).toMatch(/^http:\/\/localhost:\d+\/api\/calendar\/[\w-]{43}\.ics$/);
  // Google Calendar only takes the link as webcal://.
  const google = await dialog
    .getByRole('link', { name: 'Add to Google Calendar' })
    .getAttribute('href');
  expect(new URL(google!).searchParams.get('cid')).toBe(link.replace(/^http:/, 'webcal:'));

  // Calendar apps fetch it without signing in: the published shift and the
  // approved day off, but not the repeating shifts that are still drafts.
  const feed = await request.get(link);
  expect(feed.headers()['content-type']).toBe('text/calendar; charset=utf-8');
  const ics = await feed.text();
  expect(ics).toContain('SUMMARY:On-Call shift');
  expect(ics).toContain('SUMMARY:Time off: Personal Day');
  expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  // Google Calendar checks robots.txt before fetching.
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toContain('Allow: /api/calendar/');
});

test('a member swaps a shift with a coworker, and the admin approves', async ({ request }) => {
  // A second person in Tier 1.
  await admin.goto('/admin/people');
  await admin.getByRole('button', { name: 'Invite people' }).click();
  const invite = admin.getByRole('dialog');
  await invite.getByLabel('Full name').fill(COWORKER.name);
  await invite.getByLabel('Work email').fill(COWORKER.email);
  await invite.getByLabel('Tier').selectOption({ label: 'Tier 1' });
  await invite.getByRole('button', { name: 'Send invite' }).click();
  const link = await waitForEmail(request, { to: COWORKER.email, kind: 'invite' });
  await coworker.goto(linkIn(link, '/set-password'));
  await coworker.getByLabel('New password').fill(COWORKER.password);
  await coworker.getByLabel('Confirm password').fill(COWORKER.password);
  await coworker.getByRole('button', { name: 'Set password & continue' }).click();
  await expect(coworker).toHaveURL(/\/my-schedule$/);

  // Priya offers her On-Call shift to Sam.
  await member.goto('/my-schedule');
  await member
    .getByRole('button', { name: /09:00 – 17:00|9:00 AM – 5:00 PM/ })
    .first()
    .click();
  await member.getByRole('dialog').getByRole('button', { name: 'Offer to a coworker' }).click();
  const offer = member.getByRole('dialog', { name: 'Offer this shift' });
  await offer.getByRole('radio', { name: /Sam Chen/ }).check();
  await offer.getByRole('button', { name: 'Send request' }).click();
  await expect(member.getByText('Asked Sam')).toBeVisible();
  const ask = await waitForEmail(request, { to: COWORKER.email, kind: 'swap_requested' });
  expect(ask.subject).toMatch(/^Priya Patel asked you to take their shift on /);

  // Sam accepts; the admin is asked to approve.
  await coworker.goto('/my-schedule');
  await coworker.getByRole('button', { name: 'Accept' }).click();
  await expect(coworker.getByText(/Accepted: an admin will approve it/)).toBeVisible();
  const notice = await waitForEmail(request, { to: ADMIN.email, kind: 'swap_accepted' });
  expect(notice.subject).toMatch(/^Swap to approve: Priya Patel → Sam Chen, /);

  await admin.goto('/admin/shift-requests');
  await expect(admin.getByRole('link', { name: /Swaps & open shifts/ })).toContainText('1');
  await admin.getByRole('button', { name: 'Approve' }).click();
  await expect(admin.getByText('Approved: Sam has the shift now')).toBeVisible();

  // It's Sam's shift now, already confirmed.
  await coworker.reload();
  const upcoming = coworker.getByRole('button', { name: /09:00 – 17:00|9:00 AM – 5:00 PM/ });
  await expect(upcoming.first()).toBeVisible();
  await expect(upcoming.first().getByLabel('Confirmed')).toBeVisible();
});

test('an admin posts an open shift, and the first to pick it up gets it', async ({ request }) => {
  await admin.goto('/admin/shift-requests?tab=open');
  await admin.getByRole('button', { name: 'Post open shift' }).first().click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByLabel('Note').fill('Covering for a sick day');
  await dialog.getByRole('button', { name: 'Post and email Tier 1' }).click();
  await expect(admin.getByText('Open shift posted')).toBeVisible();
  const posted = await waitForEmail(request, { to: MEMBER.email, kind: 'open_shift_posted' });
  expect(posted.subject).toMatch(/^Open shift on .+: can you take it\?$/);

  await member.goto('/my-schedule');
  await member.getByRole('button', { name: 'Pick up' }).click();
  await expect(member.getByText(/Picked up: it's yours once an admin approves/)).toBeVisible();
  // Sam was too late.
  await coworker.goto('/my-schedule');
  await expect(coworker.getByRole('button', { name: 'Pick up' })).toHaveCount(0);

  await admin.reload();
  await admin.getByRole('button', { name: 'Approve' }).click();
  await expect(admin.getByText("Approved: it's Priya's shift now")).toBeVisible();
  const decision = await waitForEmail(request, { to: MEMBER.email, kind: 'open_shift_reviewed' });
  expect(decision.subject).toMatch(/^You've got the shift on /);
});

test('the Hours page totals published hours per person', async () => {
  await admin.goto('/admin/hours?weeks=4');
  await expect(admin.getByRole('heading', { name: 'Hours' })).toBeVisible();
  await expect(admin.getByRole('row', { name: /Priya Patel/ })).toBeVisible();
  await expect(admin.getByRole('row', { name: /Sam Chen/ })).toContainText('8h');
});
