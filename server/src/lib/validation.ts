import { IANAZone } from 'luxon';
import { z } from 'zod';
import { zodToHttpError } from '../errors';

/** Parse input with a schema, throwing a 400 with per-field messages on failure. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data);
  if (!result.success) throw zodToHttpError(result.error);
  return result.data;
}

export const zId = z.guid({ message: 'Invalid id' });
export const zDate = z.iso.date({ message: 'Use a date like 2026-10-06' });
export const zDateTime = z.iso.datetime({ offset: true, message: 'Invalid date and time' });
export const zColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #4f46e5');
export const zEmail = z
  .string({ message: 'Email is required' })
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Enter a valid email address' }).max(254));
export const zPassword = z
  .string({ message: 'Password is required' })
  .min(8, 'Password must be at least 8 characters')
  .max(200, 'Password is too long');
export const zTimezone = z
  .string()
  .refine((tz) => IANAZone.isValidZone(tz), { message: 'Unknown time zone' });

export const zName = (label: string, max: number) =>
  z
    .string({ message: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be ${max} characters or fewer`);

/** Optional free text: blank strings become null. */
export const zText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer`)
    .nullish()
    .transform((v) => (v ? v : null));

export const zIdParam = z.object({ id: zId });
