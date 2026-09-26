import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

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

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

test.describe.configure({ mode: 'serial' });

const ADMIN = { name: 'Robin Admin', email: 'robin@example.com', password: 'admin password 1' };
const MEMBER = { name: 'Priya Patel', email: 'priya@example.com', password: 'member password 1' };

let admin: Page;
let member: Page;

test.beforeAll(async ({ browser }) => {
  admin = await newPage(browser);
  member = await newPage(browser);
});

test('first admin sets up the workspace and confirms their email', async ({ request }) => {
  await admin.goto('/');
  await expect(admin).toHaveURL(/\/setup$/);
  await admin.getByLabel('Team or organization name').fill('Support Team');
  await admin.getByLabel('Your name').fill(ADMIN.name);
  await admin.getByLabel('Your email').fill(ADMIN.email);
  await admin.getByLabel('Password').fill(ADMIN.password);
  await admin.getByRole('button', { name: 'Create admin account' }).click();
  await expect(admin.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  const verify = await waitForEmail(request, { to: ADMIN.email, kind: 'verify_email' });
  await admin.goto(linkIn(verify, '/verify-email'));
  await admin.getByRole('button', { name: 'Confirm my email' }).click();
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

  const invite = await waitForEmail(request, { to: MEMBER.email, kind: 'invite' });
  expect(invite.subject).toBe('Robin Admin invited you to the Support Team schedule');
  await member.goto(linkIn(invite, '/set-password'));
  await expect(member.getByRole('heading', { name: 'Welcome, Priya!' })).toBeVisible();
  await member.getByLabel('New password').fill(MEMBER.password);
  await member.getByLabel('Confirm password').fill(MEMBER.password);
  await member.getByRole('button', { name: 'Set password & continue' }).click();
  await expect(member).toHaveURL(/\/my-schedule$/);
});

test('admin builds a draft that the team cannot see yet, then publishes it', async () => {
  await admin.goto('/admin/schedules');
  await admin.getByRole('button', { name: 'New schedule' }).first().click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Create draft' }).click();
  await expect(admin.getByText('Draft.')).toBeVisible();

  await admin
    .getByRole('button', { name: /^Add shift for Priya Patel on / })
    .first()
    .click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByRole('button', { name: 'On-Call' }).click();
  await dialog.getByRole('button', { name: 'Add shift', exact: true }).click();
  await expect(admin.getByRole('button', { name: /9am–5pm, On-Call, draft/ })).toBeVisible();

  // Drafts are invisible to members (the new schedule starts next week).
  await member.goto('/team');
  await member.getByRole('button', { name: 'Next' }).click();
  await expect(member.getByRole('row', { name: /Priya Patel/ })).toBeVisible();
  await expect(member.getByText('9am–5pm')).toHaveCount(0);

  await admin.getByRole('button', { name: 'Publish', exact: true }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Publish & email team' }).click();
  await expect(admin.getByText('Schedule published')).toBeVisible();
  await expect(admin.getByRole('button', { name: 'Published' })).toBeDisabled();
});

test('the member confirms their shift from the email link', async ({ request }) => {
  const email = await waitForEmail(request, { to: MEMBER.email, kind: 'schedule_published' });
  expect(email.subject).toMatch(/^Your Tier 1 schedule for .+ is ready$/);
  await member.goto(linkIn(email, '/confirm-shift/'));
  await expect(member).toHaveURL(/\/my-schedule$/);
  await expect(member.getByText('Shift confirmed — thanks!')).toBeVisible();
  await expect(member.getByText('waiting for your confirmation')).toHaveCount(0);
  const upcoming = member.getByRole('button', { name: /9:00 AM – 5:00 PM/ });
  await expect(upcoming).toBeVisible();
  await expect(upcoming.getByLabel('Confirmed')).toBeVisible();

  // The admin sees the confirmation.
  await admin.reload();
  await expect(admin.getByText('1/1 confirmed')).toBeVisible();
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
