// Stands in for web/src/api/client.ts in the Apps Script build: the same
// exports, but calls go through google.script.run instead of fetch. Reads
// made together (a screen's queries) share one round trip.
import type { ApiErrorBody } from '@shared/types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;

  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

interface Result {
  status: number;
  body?: unknown;
  /** Emails were queued: ask for them to go out now rather than at the next timer. */
  queued?: number;
}

interface Pending {
  path: string;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
}

let reads: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flushReads(): void {
  const batch = reads;
  reads = [];
  timer = null;
  if (batch.length === 1) {
    const [only] = batch;
    google.script.run
      .withSuccessHandler((json) => only!.resolve(JSON.parse(json) as Result))
      .withFailureHandler(only!.reject)
      .api('GET', only!.path, null);
    return;
  }
  google.script.run
    .withSuccessHandler((json) => {
      const results = JSON.parse(json) as Result[];
      batch.forEach((call, i) => call.resolve(results[i]!));
    })
    .withFailureHandler((error) => batch.forEach((call) => call.reject(error)))
    .apiBatch(JSON.stringify(batch.map((call) => ['GET', call.path])));
}

function send(method: string, path: string, body?: unknown): Promise<Result> {
  return new Promise((resolve, reject) => {
    if (method === 'GET') {
      reads.push({ path, resolve, reject });
      timer ??= setTimeout(flushReads, 5);
      return;
    }
    google.script.run
      .withSuccessHandler((json) => resolve(JSON.parse(json) as Result))
      .withFailureHandler(reject)
      .api(method, path, body === undefined ? null : JSON.stringify(body));
  });
}

/** Reads that take this long are given up on (Google may be busy; a save is never given up on). */
const READ_TIMEOUT_MS = 40_000;

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error) => (clearTimeout(timer), reject(error)),
    );
  });
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Result;
  try {
    const sending = send(method, path, body);
    res = await (method === 'GET' ? within(sending, READ_TIMEOUT_MS) : sending);
  } catch (err) {
    console.error(err);
    if (err instanceof Error && err.message === 'timeout') {
      throw new ApiError(
        0,
        'TIMEOUT',
        'This is taking longer than it should. Google may be busy: try again in a moment.',
      );
    }
    // Google's own reason, e.g. "Authorization is required to perform that action."
    const reason = err instanceof Error && err.message ? ` (${err.message})` : '';
    throw new ApiError(
      0,
      'NETWORK',
      `Can't reach Google Apps Script${reason}. Check your connection and try again.`,
    );
  }
  if (res.queued) {
    google.script.run.withFailureHandler(() => undefined).sendQueuedEmails();
  }
  if (res.status >= 400) {
    const err = (res.body as ApiErrorBody | undefined)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? `Something went wrong (HTTP ${res.status})`,
      err?.fields,
    );
  }
  return res.body as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T = void>(path: string) => request<T>('DELETE', path),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

export function qs(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}
