import { expect, test, type APIRequestContext, type Browser } from '@playwright/test';

// The Apps Script version, signed in as different Google accounts (?as=… stands
// in for Google sign-in). Demo data: see apps-script/preview.ts.

const ADMIN = 'alex@example.com';

async function open(browser: Browser, email: string, path = '/') {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}as=${email}`);
  return page;
}

interface Sent {
  to: string;
  subject: string;
  body: string;
}
const sent = async (request: APIRequestContext) =>
  (await (await request.get('/mail.json')).json()) as Sent[];

test('an admin publishes, and the team member confirms from the email', async ({
  browser,
  request,
}) => {
  const admin = await open(browser, ADMIN, '/admin/schedules');
  await expect(admin.getByText('1 unpublished change this week')).toBeVisible();
  await admin.getByRole('button', { name: 'Publish 1 change' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Publish & notify' }).click();
  await expect(admin.getByRole('button', { name: 'All published' })).toBeDisabled();

  // The page asks Apps Script to send the emails right away (through Gmail).
  const toTaylor = () =>
    sent(request).then((all) =>
      all.find((m) => m.to === 'taylor@example.com' && m.subject.startsWith('Your schedule')),
    );
  await expect.poll(toTaylor).toBeTruthy();
  const link = /http:\/\/localhost:4400\/exec\/confirm-shift\/[0-9a-f-]+/.exec(
    (await toTaylor())!.body,
  );
  expect(link).not.toBeNull();

  const taylor = await open(
    browser,
    'taylor@example.com',
    link![0].replace(/^http:\/\/localhost:4400/, ''),
  );
  await expect(taylor.getByText('Shift confirmed — thanks!')).toBeVisible();
  // The address bar follows the app, so a reload stays put.
  await expect(taylor).toHaveURL(/page=%2Fmy-schedule/);
  await taylor.reload();
  await expect(taylor.getByRole('heading', { name: 'My schedule' })).toBeVisible();
});

test('a team member asks for a personal day, and an admin approves it', async ({ browser }) => {
  const priya = await open(browser, 'priya@example.com', '/my-schedule');
  await priya.getByRole('button', { name: 'Request time off' }).first().click();
  const dialog = priya.getByRole('dialog');
  await dialog.getByText('Personal Day').click();
  await dialog.getByLabel('Note for your admin').fill('Appointment');
  await dialog.getByRole('button', { name: /^Request 1 day$/ }).click();
  await expect(priya.getByText('Waiting for approval').first()).toBeVisible();

  const admin = await open(browser, ADMIN, '/admin/time-off');
  await expect(admin.getByText('“Appointment”')).toBeVisible();
  await admin.getByRole('button', { name: 'Approve' }).first().click();
  await expect(admin.getByText("Priya Patel's Personal Day approved")).toBeVisible();
});

test('Google sign-in: no passwords or sign-out, and newcomers are told who to ask', async ({
  browser,
}) => {
  const admin = await open(browser, ADMIN, '/profile');
  await expect(admin.getByRole('heading', { name: 'Details' })).toBeVisible();
  await expect(admin.getByText('The Google account you sign in with.')).toBeVisible();
  for (const gone of ['Password', 'Devices', 'Calendar']) {
    await expect(admin.getByRole('heading', { name: gone, exact: true })).toHaveCount(0);
  }
  await expect(admin.getByRole('button', { name: 'Sign out' })).toHaveCount(0);

  const stranger = await open(browser, 'stranger@example.com');
  await expect(
    stranger.getByText("You're not on the Northwind Support schedule yet"),
  ).toBeVisible();
  await expect(stranger.getByText('signed in to Google as stranger@example.com')).toBeVisible();
});

test('Back goes to the previous screen', async ({ browser }) => {
  const admin = await open(browser, ADMIN, '/admin');
  await admin.getByRole('link', { name: 'People', exact: true }).click();
  await expect(admin.getByRole('heading', { name: 'People' })).toBeVisible();
  await admin.getByRole('link', { name: 'Hours', exact: true }).click();
  await expect(admin.getByRole('heading', { name: 'Hours' })).toBeVisible();
  await admin.goBack();
  await expect(admin.getByRole('heading', { name: 'People' })).toBeVisible();
});

test('a team member puts their confirmed shifts in Google Calendar', async ({
  browser,
  request,
}) => {
  const sam = await open(browser, 'sam@example.com', '/my-schedule');
  await sam.getByRole('button', { name: 'Add to Google Calendar' }).click();
  await sam.getByRole('dialog').getByRole('button', { name: 'Turn on' }).click();
  await expect(
    sam.getByText('Your confirmed shifts will show up in Google Calendar'),
  ).toBeVisible();
  await expect(sam.getByRole('button', { name: 'Google Calendar', exact: true })).toBeVisible();

  const onCalendar = async () =>
    ((await (await request.get('/calendar.json')).json()) as { guests: string[] }[]).filter((e) =>
      e.guests.includes('sam@example.com'),
    ).length;
  expect(await onCalendar()).toBe(0); // nothing confirmed yet
  await sam.getByRole('button', { name: /^Confirm all/ }).click();
  await expect.poll(onCalendar).toBeGreaterThan(0);

  await sam.goto('/profile?as=sam@example.com');
  await expect(sam.getByRole('switch', { name: 'Add my shifts to Google Calendar' })).toBeChecked();
});

test('the schedule builder has a Day view with people working each hour', async ({ browser }) => {
  const admin = await open(browser, ADMIN, '/admin/schedules');
  await admin.getByRole('tab', { name: 'Day' }).click();
  // Hours across the top, a bar per shift, and a count of who is working each hour.
  await expect(admin.getByRole('columnheader', { name: '9am' })).toBeVisible();
  await expect(admin.getByRole('rowheader', { name: /People working/ })).toBeVisible();
  const bars = admin.getByRole('button', { name: /waiting for confirmation|confirmed|draft/ });
  await expect(bars.first()).toBeVisible();

  // Stepping to the next day leaves today.
  await expect(admin.getByRole('button', { name: 'Today' })).toBeDisabled();
  await admin.getByRole('button', { name: 'Next' }).click();
  await expect(admin.getByRole('button', { name: 'Today' })).toBeEnabled();

  // Clicking someone's empty row starts a shift for them.
  await admin.getByRole('button', { name: 'Add shift for Riley Adams' }).click();
  await expect(admin.getByRole('dialog').getByRole('heading', { name: 'Add shift' })).toBeVisible();
});
