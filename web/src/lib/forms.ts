import { ApiError } from '../api/client';

/** Per-field messages from a server validation error. */
export function fieldErrors(error: unknown): Record<string, string> {
  return error instanceof ApiError && error.fields ? error.fields : {};
}

/** A form-level message, unless the error is already shown next to a field. */
export function formMessage(error: unknown, shownFields: string[] = []): string | null {
  if (!error) return null;
  const fields = fieldErrors(error);
  if (Object.keys(fields).some((f) => shownFields.includes(f))) return null;
  return error instanceof Error ? error.message : 'Something went wrong';
}

export function isCode(error: unknown, code: string): boolean {
  return error instanceof ApiError && error.code === code;
}
