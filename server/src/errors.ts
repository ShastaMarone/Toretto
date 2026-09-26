import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { Logger } from './logger';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    extra: { fields?: Record<string, string>; details?: unknown } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = extra.fields;
    this.details = extra.details;
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) =>
  new HttpError(400, 'BAD_REQUEST', message, { fields });
export const unauthorized = (message = 'Please sign in to continue') =>
  new HttpError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = "You don't have permission to do that", code = 'FORBIDDEN') =>
  new HttpError(403, code, message);
export const notFound = (what = 'Item') => new HttpError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (message: string, code = 'CONFLICT', details?: unknown) =>
  new HttpError(409, code, message, { details });

export function zodToHttpError(err: ZodError): HttpError {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.map(String).join('.') || '_';
    fields[key] ??= issue.message;
  }
  const message = err.issues[0]?.message ?? 'Invalid input';
  return new HttpError(400, 'VALIDATION_ERROR', message, { fields });
}

interface PgError {
  code?: string;
  constraint?: string;
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    let httpError: HttpError;
    if (err instanceof HttpError) httpError = err;
    else if (err instanceof ZodError) httpError = zodToHttpError(err);
    else if (err?.type === 'entity.parse.failed')
      httpError = new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
    else if (err?.type === 'entity.too.large')
      httpError = new HttpError(413, 'TOO_LARGE', 'Request body is too large');
    else if ((err as PgError)?.code === '23505')
      httpError = conflict('That name or email is already in use', 'ALREADY_EXISTS');
    else if ((err as PgError)?.code === '23503')
      httpError = conflict('This item is still in use elsewhere', 'IN_USE');
    else if ((err as PgError)?.code === '23514')
      httpError = new HttpError(400, 'INVALID_VALUE', 'One of the values is out of range');
    else if ((err as PgError)?.code === '22P02')
      httpError = new HttpError(400, 'INVALID_ID', 'Malformed identifier');
    else {
      logger.error(`Unhandled error on ${req.method} ${req.path}`, err);
      httpError = new HttpError(500, 'INTERNAL', 'Something went wrong. Please try again.');
    }
    res.status(httpError.status).json({
      error: {
        code: httpError.code,
        message: httpError.message,
        ...(httpError.fields ? { fields: httpError.fields } : {}),
        ...(httpError.details !== undefined ? { details: httpError.details } : {}),
      },
    });
  };
}
