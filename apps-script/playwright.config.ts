import { defineConfig, devices } from '@playwright/test';

/**
 * The Google Apps Script version in a browser: the built page against the
 * Apps Script code and an emulated Sheet (apps-script/preview.ts).
 * `npm run test:e2e:apps-script` builds first.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:4400',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx tsx apps-script/preview.ts',
    cwd: '..',
    url: 'http://localhost:4400/mail.json',
    reuseExistingServer: false,
    timeout: 60_000,
    env: { PORT: '4400' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
