/**
 * All "day" values in this system are `dateKey` strings ("YYYY-MM-DD") computed in
 * Asia/Kolkata. Comparing raw Date objects across timezones produces off-by-one-day
 * bugs in attendance, so days never travel as Date.
 */

export const IST_TIME_ZONE = 'Asia/Kolkata';

const IST_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Converts an instant to its IST calendar day, e.g. "2026-08-25". */
export function toDateKey(date: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape we want.
  return IST_FORMATTER.format(date);
}

/** The IST month a dateKey belongs to, e.g. "2026-08-25" -> "2026-08". */
export function toPeriod(dateKey: string): string {
  return dateKey.slice(0, 7);
}

export const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
export const ACADEMIC_YEAR_PATTERN = /^\d{4}-\d{2}$/;

export function isValidDateKey(value: string): boolean {
  if (!DATE_KEY_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/**
 * The Indian academic year runs April -> March, so a date in Jan 2027 still belongs
 * to the "2026-27" session. Returns a label like "2026-27".
 */
/**
 * True when a dateKey falls on a Sunday.
 *
 * A dateKey is a bare calendar date with no time, so it is parsed as UTC — the day of the
 * week of "2026-08-30" is the same everywhere, and going through a local Date would let
 * the machine's timezone shift it.
 */
export function isSunday(dateKey: string): boolean {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay() === 0;
}

/** Label shown for an automatic Sunday holiday, so it reads the same everywhere. */
export const SUNDAY_HOLIDAY_LABEL = 'Sunday';

export function academicYearFor(date: Date = new Date()): string {
  return academicYearForPeriod(toPeriod(toDateKey(date)));
}

/**
 * Academic year for a given period, e.g. "2026-03" -> "2025-26".
 *
 * Needed wherever a record belongs to a month other than today's: an opening balance
 * dated March 2026 falls in the 2025-26 session, so stamping it with the *active* year
 * would file it under the wrong session and skew that year's totals.
 */
export function academicYearForPeriod(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const startYear = month >= 4 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/**
 * Last calendar day of a period, e.g. "2026-02" -> "2026-02-29" in a leap year.
 *
 * Computed in UTC on purpose: day 0 of the following month is the last day of this one,
 * and doing the arithmetic in UTC keeps it independent of the machine's timezone. The
 * result is a plain dateKey, so nothing downstream has to care.
 */
export function lastDayOfPeriod(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(day).padStart(2, '0')}`;
}

/** Two-digit year used in generated IDs, e.g. "2026-27" -> "26". */
export function academicYearShort(academicYear: string): string {
  return academicYear.slice(2, 4);
}
