import { describe, expect, it } from 'vitest';
import { istMonthInstants } from './dateRange.js';

/**
 * The point of this helper is that a timestamp is not a calendar day. IST runs +05:30
 * ahead of UTC, so an IST month begins the previous evening in UTC — get that wrong and
 * everything created after 18:30 on the last day of a month files into the next one.
 */
describe('istMonthInstants', () => {
  it('starts an IST month at 18:30 UTC on the last day of the month before', () => {
    const { start, end } = istMonthInstants('2026-09');
    expect(start.toISOString()).toBe('2026-08-31T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });

  it('rolls the year over at December', () => {
    const { start, end } = istMonthInstants('2026-12');
    expect(start.toISOString()).toBe('2026-11-30T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-12-31T18:30:00.000Z');
  });

  it('handles a leap February by its length, not a fixed 28', () => {
    expect(istMonthInstants('2028-02').end.toISOString()).toBe('2028-02-29T18:30:00.000Z');
    expect(istMonthInstants('2026-02').end.toISOString()).toBe('2026-02-28T18:30:00.000Z');
  });

  // The two ends must meet exactly, or an instant in the seam belongs to no month or to
  // both — which is what a `$lte` upper bound would cause.
  it('meets the next month with no gap and no overlap', () => {
    expect(istMonthInstants('2026-09').end.getTime()).toBe(istMonthInstants('2026-10').start.getTime());
  });

  it('puts the last evening of an IST month in that month, not the next', () => {
    // 2026-09-30 23:59 IST.
    const lastEvening = new Date('2026-09-30T18:29:00.000Z');
    const { start, end } = istMonthInstants('2026-09');
    expect(lastEvening >= start && lastEvening < end).toBe(true);
    // One minute later is October.
    expect(new Date('2026-09-30T18:30:00.000Z') < end).toBe(false);
  });

  it('rejects a malformed month', () => {
    expect(() => istMonthInstants('2026-13')).toThrow(/2026-08/);
    expect(() => istMonthInstants('September')).toThrow();
  });
});
