import { PERIOD_PATTERN } from '@rntps/shared';
import { AppError } from './AppError.js';

/**
 * Every dateKey in a month, e.g. "2026-08" -> ["2026-08-01", ... "2026-08-31"].
 * Built arithmetically rather than with Date, so it cannot drift by a timezone.
 */
export function dateKeysInMonth(month: string): string[] {
  if (!PERIOD_PATTERN.test(month)) throw AppError.badRequest('Month must be in the form 2026-08');

  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7));
  // Day 0 of the next month is the last day of this one.
  const days = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();

  return Array.from(
    { length: days },
    (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`,
  );
}

/** Inclusive bounds for querying a month by dateKey string comparison. */
export function monthBounds(month: string): { from: string; to: string } {
  const keys = dateKeysInMonth(month);
  return { from: keys[0] as string, to: keys[keys.length - 1] as string };
}

/** Sunday check without constructing a local Date. */
export function isSunday(dateKey: string): boolean {
  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0;
}
