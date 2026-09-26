import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const vercel = {
  NODE_ENV: 'production',
  VERCEL: '1',
  VERCEL_URL: 'toretto-abc123-team.vercel.app',
  VERCEL_BRANCH_URL: 'toretto-git-main-team.vercel.app',
  VERCEL_PROJECT_PRODUCTION_URL: 'toretto.vercel.app',
  DATABASE_URL: 'postgres://u:p@db.example.com/toretto',
};

describe('configuration on Vercel', () => {
  it('uses the production URL for links and accepts requests from every deployment URL', () => {
    const config = loadConfig({ ...vercel, VERCEL_ENV: 'production' });
    expect(config.appUrl).toBe('https://toretto.vercel.app');
    expect(config.allowedOrigins.sort()).toEqual([
      'https://toretto-abc123-team.vercel.app',
      'https://toretto-git-main-team.vercel.app',
      'https://toretto.vercel.app',
    ]);
    expect(config.secureCookies).toBe(true);
    expect(config.trustProxy).toBe(1);
    expect(config.onVercel).toBe(true);
    expect(config.isLocal).toBe(false);
    expect(config.openSetup).toBe(false);
  });

  it('links preview deployments to their branch URL', () => {
    const config = loadConfig({ ...vercel, VERCEL_ENV: 'preview' });
    expect(config.appUrl).toBe('https://toretto-git-main-team.vercel.app');
  });

  it('prefers an explicit APP_URL (a custom domain)', () => {
    const config = loadConfig({
      ...vercel,
      VERCEL_ENV: 'production',
      APP_URL: 'https://schedule.example.com/',
    });
    expect(config.appUrl).toBe('https://schedule.example.com');
    expect(config.allowedOrigins).toContain('https://schedule.example.com');
    expect(config.allowedOrigins).toContain('https://toretto.vercel.app');
  });

  it('falls back to POSTGRES_URL from a Vercel database integration', () => {
    const { DATABASE_URL: _, ...rest } = vercel;
    const config = loadConfig({ ...rest, POSTGRES_URL: 'postgres://neon.example/db' });
    expect(config.databaseUrl).toBe('postgres://neon.example/db');
    expect(loadConfig({ ...vercel, POSTGRES_URL: 'postgres://other' }).databaseUrl).toBe(
      vercel.DATABASE_URL,
    );
    expect(() => loadConfig(rest)).toThrow('DATABASE_URL is required in production');
  });

  it('keeps defaults elsewhere', () => {
    const config = loadConfig({ APP_URL: 'https://schedule.example.com', DATABASE_URL: 'x' });
    expect(config.onVercel).toBe(false);
    expect(config.trustProxy).toBe(0);
    expect(config.allowedOrigins).toEqual(['https://schedule.example.com']);
    expect(config.cronSecret).toBeNull();
    expect(loadConfig({ TRUST_PROXY: '2' }).trustProxy).toBe(2);
  });

  it('rejects a short cron secret', () => {
    expect(() => loadConfig({ CRON_SECRET: 'short' })).toThrow('CRON_SECRET');
  });
});
