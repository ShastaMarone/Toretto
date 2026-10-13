// The same helpers as server/test/helpers.ts, for the Apps Script version:
// tests read like the server's, but every call goes through api() against an
// emulated Google Sheet, and signing in is choosing whose Google account it is.
import { addDays, shiftTimesFromLocal, startOfWeek, todayIn } from '@shared/time';
import { tables } from '../src/core';
import { Db } from '../src/db/store';
import * as main from '../src/main';
import { activate, createEmulator, installAppsScript, type Emulator } from './emulator';

export const TZ = 'America/Toronto';
export const APP_URL = 'https://script.google.com/macros/s/TEST/exec';

type Tables = ReturnType<typeof tables>;

/** Read and change the Sheet directly (what server tests do with SQL). */
export interface TestDb {
  read<T>(fn: (t: Tables) => T): T;
  write<T>(fn: (t: Tables, db: Db) => T): T;
}

export interface Response {
  status: number;
  // Tests read arbitrary JSON, as with supertest.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  text: string;
}

class Call implements PromiseLike<Response> {
  private body: unknown;
  private expected: number | null = null;

  constructor(
    private readonly agent: Agent,
    private readonly method: string,
    private readonly url: string,
  ) {}

  send(body: unknown): this {
    this.body = body;
    return this;
  }

  expect(status: number): this {
    this.expected = status;
    return this;
  }

  private run(): Response {
    activate(this.agent.env);
    this.agent.env.activeUser = this.agent.email;
    const json = main.api(
      this.method,
      this.url.replace(/^\/api/, ''),
      this.body === undefined ? null : JSON.stringify(this.body),
    );
    const res = JSON.parse(json) as { status: number; body?: unknown; queued?: number };
    // The page asks for queued emails to go out right away (the server "kicks" its worker).
    if (res.queued) this.agent.env.kicks++;
    const response = {
      status: res.status,
      body: res.body ?? {},
      text: JSON.stringify(res.body ?? ''),
    };
    if (this.expected !== null && res.status !== this.expected) {
      throw new Error(
        `${this.method} ${this.url}: expected ${this.expected}, got ${res.status} ${response.text}`,
      );
    }
    return response;
  }

  then<A = Response, B = never>(
    onFulfilled?: ((value: Response) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    let result: Promise<Response>;
    try {
      result = Promise.resolve(this.run());
    } catch (err) {
      result = Promise.reject(err);
    }
    return result.then(onFulfilled, onRejected);
  }
}

/** Someone using the app: their Google account is who they are. */
export class Agent {
  email = '';
  constructor(readonly env: Emulator) {}
  get = (url: string) => new Call(this, 'GET', url);
  post = (url: string) => new Call(this, 'POST', url);
  patch = (url: string) => new Call(this, 'PATCH', url);
  delete = (url: string) => new Call(this, 'DELETE', url);
}

export interface TestContext {
  env: Emulator;
  db: TestDb;
  /** How many responses asked for emails to be sent right away. */
  kicks: () => number;
  agent(): Agent;
  close(): Promise<void>;
}

/** A fresh Sheet, set up as setup() does (with no owner account, so tests add their own admins). */
export async function createTestContext(): Promise<TestContext> {
  installAppsScript();
  const env = createEmulator();
  activate(env);
  env.owner = '';
  main.setup();
  env.owner = 'owner@example.com';
  const db: TestDb = {
    read: (fn) => {
      activate(env);
      return fn(tables(new Db()));
    },
    write: (fn) => {
      activate(env);
      const store = new Db();
      const result = fn(tables(store), store);
      store.commit();
      return result;
    },
  };
  // Like the server's tests, start without the starter tiers and labels.
  db.write((t) => {
    for (const label of t.labels.all()) t.labels.delete(label.id);
    for (const tier of t.tiers.all()) t.tiers.delete(tier.id);
  });
  return {
    env,
    db,
    kicks: () => env.kicks,
    agent: () => new Agent(env),
    close: async () => undefined,
  };
}

export async function createUser(
  db: TestDb,
  input: {
    name: string;
    email?: string;
    role?: 'admin' | 'member';
    tierId?: string | null;
    teamId?: string | null;
    verified?: boolean;
    timezone?: string | null;
  },
): Promise<{ id: string; name: string; email: string }> {
  const email = input.email ?? `${input.name.toLowerCase().replace(/\W+/g, '.')}@example.com`;
  return db.write((t, store) => {
    const row = t.users.insert({
      name: input.name,
      email,
      role: input.role ?? 'member',
      tierId: input.tierId ?? null,
      teamId: input.teamId ?? null,
      timezone: input.timezone ?? null,
      emailVerifiedAt: input.verified === false ? null : store.now,
    });
    return { id: row.id, name: input.name, email };
  });
}

/** Sign in: from now on this agent is that Google account. */
export async function login(agent: Agent, email: string) {
  agent.email = email.toLowerCase();
  const res = await agent.get('/api/bootstrap');
  if (!res.body.user) throw new Error(`${email} isn't on the People list`);
  return res.body.user as { id: string };
}

export async function createTier(db: TestDb, name: string, color = '#4f46e5'): Promise<string> {
  return db.write((t) => t.tiers.insert({ name, color }).id);
}

export async function createLabel(
  db: TestDb,
  name: string,
  tierId: string | null,
  color = '#dc2626',
): Promise<string> {
  return db.write((t) => t.labels.insert({ tierId, name, color }).id);
}

export async function defaultScheduleId(db: TestDb): Promise<string> {
  return db.read((t) => t.schedules.find((s) => s.isDefault)!.id);
}

export function nextMonday(): string {
  return addDays(startOfWeek(todayIn(TZ), 1), 7);
}

export function shiftOn(date: string, start = '09:00', end = '17:00') {
  return shiftTimesFromLocal(date, start, end, TZ);
}

export interface Email {
  kind: string;
  toEmail: string;
  subject: string;
  html: string;
  text: string;
  scheduleId: string | null;
  shiftIds: string[];
}

export async function emails(
  db: TestDb,
  filter: { to?: string; kind?: string } = {},
): Promise<Email[]> {
  return db.read((t) =>
    t.notifications
      .where(
        (n) => (!filter.to || n.toEmail === filter.to) && (!filter.kind || n.kind === filter.kind),
      )
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map((n) => ({
        kind: n.kind,
        toEmail: n.toEmail,
        subject: n.subject,
        html: n.html,
        text: n.text,
        scheduleId: n.scheduleId,
        shiftIds: n.shiftIds,
      })),
  );
}

export async function clearEmails(db: TestDb): Promise<void> {
  db.write((t) => {
    for (const n of t.notifications.all()) t.notifications.delete(n.id);
  });
}

export function linkIn(email: Email, path: string): string {
  const match = new RegExp(`${APP_URL.replace(/\./g, '\\.')}${path}[^\\s]*`).exec(email.text);
  if (!match) throw new Error(`No ${path} link in email "${email.subject}":\n${email.text}`);
  return match[0];
}
