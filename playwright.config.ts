import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://toretto:toretto@localhost:5432/toretto_e2e';

/**
 * End-to-end config for a built app served by `server` on PORT, with a
 * throwaway database and the console email transport. The test reads emails
 * from the dev mailbox API.
 */
export function e2eConfig(server: string, env: Record<string, string> = {}) {
  return defineConfig({
    testDir: 'e2e',
    timeout: 60_000,
    workers: 1,
    reporter: process.env.CI ? [['github'], ['list']] : 'list',
    use: {
      baseURL: `http://localhost:${PORT}`,
      trace: 'retain-on-failure',
      screenshot: 'only-on-failure',
    },
    webServer: {
      command: `node e2e/reset-db.mjs && ${server}`,
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'development',
        PORT: String(PORT),
        APP_URL: `http://localhost:${PORT}`,
        DATABASE_URL,
        EMAIL_TRANSPORT: 'console',
        RATE_LIMIT: 'false',
        LOG_LEVEL: 'warn',
        WORKER_POLL_MS: '500',
        ...env,
      },
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  });
}

// The production build (`npm run test:e2e` builds first).
export default e2eConfig('node dist/server/index.js');
