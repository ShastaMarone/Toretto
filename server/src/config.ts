import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { LogLevel } from './logger';

export type EmailTransportKind = 'console' | 'smtp' | 'postmark' | 'sendgrid';

export interface Config {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  /** Public base URL without trailing slash, e.g. https://schedule.example.com */
  appUrl: string;
  appOrigin: string;
  databaseUrl: string;
  /** Only this email may complete first-run setup (required in production). */
  adminEmail: string | null;
  email: {
    transport: EmailTransportKind;
    from: string;
    smtpUrl: string | null;
    postmarkToken: string | null;
    postmarkStream: string;
    sendgridKey: string | null;
  };
  runWorker: boolean;
  workerPollMs: number;
  trustProxy: number;
  logLevel: LogLevel;
  /** APP_URL points at this machine (localhost), i.e. a developer's laptop. */
  isLocal: boolean;
  /** Emails are viewable at /dev/mailbox: console transport, local, not production. */
  devMailbox: boolean;
  /** First-run setup is open to anyone (otherwise only ADMIN_EMAIL may do it). */
  openSetup: boolean;
  secureCookies: boolean;
  rateLimit: boolean;
  /** Directory with the built web app, served by Express in production. */
  staticDir: string | null;
}

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true' || v === '1' || v === 'yes'));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  APP_URL: z.url().optional(),
  DATABASE_URL: z.string().min(1).optional(),
  ADMIN_EMAIL: z.string().optional(),
  EMAIL_TRANSPORT: z.enum(['console', 'smtp', 'postmark', 'sendgrid']).default('console'),
  EMAIL_FROM: z.string().min(3).default('Toretto Scheduling <no-reply@localhost>'),
  SMTP_URL: z.string().optional(),
  POSTMARK_SERVER_TOKEN: z.string().optional(),
  POSTMARK_MESSAGE_STREAM: z.string().default('outbound'),
  SENDGRID_API_KEY: z.string().optional(),
  RUN_WORKER: bool(true),
  WORKER_POLL_MS: z.coerce.number().int().min(250).default(5000),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional(),
  RATE_LIMIT: bool(true),
  STATIC_DIR: z.string().optional(),
});

/** Load `.env` from the working directory if present (never overrides real env vars). */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings (e.g. `ADMIN_EMAIL=` in .env) as unset.
  const env = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';

  if (isProduction && !e.APP_URL) throw new Error('APP_URL is required in production');
  if (isProduction && !e.DATABASE_URL) throw new Error('DATABASE_URL is required in production');
  if (e.EMAIL_TRANSPORT === 'smtp' && !e.SMTP_URL)
    throw new Error('SMTP_URL is required when EMAIL_TRANSPORT=smtp');
  if (e.EMAIL_TRANSPORT === 'postmark' && !e.POSTMARK_SERVER_TOKEN)
    throw new Error('POSTMARK_SERVER_TOKEN is required when EMAIL_TRANSPORT=postmark');
  if (e.EMAIL_TRANSPORT === 'sendgrid' && !e.SENDGRID_API_KEY)
    throw new Error('SENDGRID_API_KEY is required when EMAIL_TRANSPORT=sendgrid');

  const appUrl = (e.APP_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
  // Safety net for deployments that forget NODE_ENV=production: developer
  // conveniences only switch on when the app is addressed as localhost.
  const host = new URL(appUrl).hostname;
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(host) || host.endsWith('.localhost');
  return {
    env: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    appUrl,
    appOrigin: new URL(appUrl).origin,
    databaseUrl: e.DATABASE_URL ?? 'postgres://toretto:toretto@localhost:5432/toretto',
    adminEmail: e.ADMIN_EMAIL ? e.ADMIN_EMAIL.trim().toLowerCase() : null,
    email: {
      transport: e.EMAIL_TRANSPORT,
      from: e.EMAIL_FROM,
      smtpUrl: e.SMTP_URL ?? null,
      postmarkToken: e.POSTMARK_SERVER_TOKEN ?? null,
      postmarkStream: e.POSTMARK_MESSAGE_STREAM,
      sendgridKey: e.SENDGRID_API_KEY ?? null,
    },
    runWorker: e.RUN_WORKER,
    workerPollMs: e.WORKER_POLL_MS,
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === 'test' ? 'silent' : 'info'),
    isLocal,
    devMailbox: e.EMAIL_TRANSPORT === 'console' && !isProduction && isLocal,
    openSetup: !isProduction && isLocal,
    secureCookies: appUrl.startsWith('https://'),
    rateLimit: e.RATE_LIMIT && e.NODE_ENV !== 'test',
    staticDir: e.STATIC_DIR ?? null,
  };
}
