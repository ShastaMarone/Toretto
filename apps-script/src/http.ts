import { ZodError } from 'zod';
import { forbidden, HttpError, notFound, unauthorized } from '../../server/src/errors';
import type { Ctx } from './core';

/** An API call from the page: the same method, path and JSON body the Express API takes. */
export interface ApiRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface ApiResponse {
  status: number;
  body?: unknown;
}

/** Who may call a route: anyone signed in to Google, anyone on the People list, or admins. */
export type Access = 'public' | 'user' | 'admin';

type Handler = (req: ApiRequest, ctx: Ctx) => unknown;

/** Return from a handler for a status other than 200. */
export class Reply {
  constructor(
    readonly status: number,
    readonly body?: unknown,
  ) {}
}
export const created = (body: unknown) => new Reply(201, body);
export const noContent = () => new Reply(204);

interface Route {
  method: string;
  parts: string[];
  access: Access;
  handler: Handler;
}

/** Split "/a/b?x=1&y=2" into the path and its query (no URLSearchParams in Apps Script). */
export function splitUrl(url: string): { path: string; query: Record<string, string> } {
  const at = url.indexOf('?');
  const path = at === -1 ? url : url.slice(0, at);
  const query: Record<string, string> = {};
  if (at !== -1) {
    for (const pair of url.slice(at + 1).split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const decode = (s: string) => decodeURIComponent(s.replace(/\+/g, ' '));
      const key = decode(eq === -1 ? pair : pair.slice(0, eq));
      if (!(key in query)) query[key] = eq === -1 ? '' : decode(pair.slice(eq + 1));
    }
  }
  return { path, query };
}

const segments = (path: string) => path.split('/').filter(Boolean);

export class Router {
  private readonly routes: Route[] = [];

  private add(method: string, path: string, access: Access, handler: Handler): void {
    this.routes.push({ method, parts: segments(path), access, handler });
  }

  get(path: string, access: Access, handler: Handler) {
    this.add('GET', path, access, handler);
  }
  post(path: string, access: Access, handler: Handler) {
    this.add('POST', path, access, handler);
  }
  patch(path: string, access: Access, handler: Handler) {
    this.add('PATCH', path, access, handler);
  }
  delete(path: string, access: Access, handler: Handler) {
    this.add('DELETE', path, access, handler);
  }

  /** Find the route for a call, with its path parameters. */
  match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const parts = segments(path);
    for (const route of this.routes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const ok = route.parts.every((part, i) => {
        if (part.startsWith(':')) {
          params[part.slice(1)] = decodeURIComponent(parts[i]!);
          return true;
        }
        return part === parts[i];
      });
      if (ok) return { route, params };
    }
    return null;
  }

  /** Run a call. Errors become the same JSON error bodies the Express API sends. */
  handle(method: string, url: string, body: unknown, ctx: Ctx): ApiResponse {
    try {
      const { path, query } = splitUrl(url);
      const found = this.match(method, path);
      if (!found) throw notFound('API endpoint');
      const { route, params } = found;
      if (route.access !== 'public') {
        if (!ctx.user) throw unauthorized();
        if (route.access === 'admin' && ctx.user.role !== 'admin') throw forbidden();
      }
      const result = route.handler({ method, path, params, query, body: body ?? {} }, ctx);
      if (result instanceof Reply) return { status: result.status, body: result.body };
      return { status: 200, body: result };
    } catch (err) {
      return errorResponse(err);
    }
  }
}

export function errorResponse(err: unknown): ApiResponse {
  let error: HttpError;
  if (err instanceof HttpError) error = err;
  else if (err instanceof ZodError) {
    error = new HttpError(400, 'VALIDATION_ERROR', err.issues[0]?.message ?? 'Invalid input');
  } else {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    // Unlike the web server, say what it was: Apps Script shows the page
    // anything a script throws anyway, and a screenshot is then enough to go on.
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    error = new HttpError(
      500,
      'INTERNAL',
      `Something went wrong (${detail.slice(0, 300)}). Please try again.`,
    );
  }
  return {
    status: error.status,
    body: {
      error: {
        code: error.code,
        message: error.message,
        ...(error.fields ? { fields: error.fields } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    },
  };
}
