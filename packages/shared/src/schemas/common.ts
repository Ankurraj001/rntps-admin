import { z } from 'zod';

/**
 * WhatsApp click-to-chat links need digits only with the country code and no "+".
 * Indian mobile numbers are 10 digits starting 6-9, so the stored form is 91XXXXXXXXXX.
 */
export const phoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s()+-]/g, ''))
  .pipe(
    z
      .string()
      .regex(/^91[6-9]\d{9}$/, 'Enter a valid Indian mobile number (e.g. 9876543210)'),
  );

/** Accepts 10-digit input from forms and normalises it to the stored 91XXXXXXXXXX form. */
export const phoneInputSchema = z
  .string()
  .trim()
  .transform((value) => {
    const digits = value.replace(/\D/g, '');
    if (digits.length === 10) return `91${digits}`;
    if (digits.length === 12 && digits.startsWith('91')) return digits;
    if (digits.length === 13 && digits.startsWith('091')) return digits.slice(1);
    return digits;
  })
  .pipe(z.string().regex(/^91[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'));

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

export type Pagination = z.infer<typeof paginationSchema>;

export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export const pincodeSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code');

/**
 * An HTML text input submits "" when left blank, which `.optional()` does not treat as
 * absent — so an empty optional field would fail its own format check. This maps blank
 * to undefined before validating.
 */
export function optionalText<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  );
}

/**
 * Like optionalText, but blank means "clear this field" rather than "leave it alone".
 *
 * The distinction matters on an update: with optionalText an emptied input is simply
 * omitted from the payload, so a value already stored can never be removed. For a unique
 * field such as Aadhaar that is a trap — an entry against the wrong student would
 * permanently block the right one.
 */
export function clearableText<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    schema.nullable().optional(),
  );
}
