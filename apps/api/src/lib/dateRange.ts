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

/**
 * IST is a fixed +05:30 with no daylight saving, so the offset is a constant rather than
 * something that has to be looked up per date.
 */
const IST_OFFSET_MS = 330 * 60_000;

/**
 * Half-open instant bounds for an IST month, for querying a real timestamp — a `createdAt`
 * — rather than a dateKey string.
 *
 * Needed because not every date in this system is a dateKey: Mongoose `timestamps` are
 * genuine instants, and "September 2026 in IST" is the window
 * `[2026-08-31T18:30:00Z, 2026-09-30T18:30:00Z)`. Comparing such a timestamp against a
 * dateKey would file anything created after 18:30 IST into the following day, and so the
 * last evening of a month into the next month.
 *
 * The upper bound is exclusive so a batch created in the final millisecond of the month is
 * neither dropped nor double-counted into the next one.
 */
export function istMonthInstants(month: string): { start: Date; end: Date } {
  if (!PERIOD_PATTERN.test(month)) throw AppError.badRequest('Month must be in the form 2026-08');

  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7));
  return {
    start: new Date(Date.UTC(year, monthIndex - 1, 1) - IST_OFFSET_MS),
    end: new Date(Date.UTC(year, monthIndex, 1) - IST_OFFSET_MS),
  };
}

/** Sunday check without constructing a local Date. */
export function isSunday(dateKey: string): boolean {
  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0;
}
