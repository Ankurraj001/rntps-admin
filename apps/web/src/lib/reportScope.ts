import {
  FULL_SESSION,
  REPORT_SCOPE_CODES,
  type ExamCode,
  type ReportScopeCode,
} from '@rntps/shared';

/**
 * What a report card is showing: one paper, or — as null — the whole session.
 *
 * Null rather than the `ALL` token because that is what the rendering code wants to ask:
 * `scope === null ? every column : [scope]`. The token is the *stored and addressable*
 * form, and this is the form the card is drawn from; `scopeFromParam` is the one place
 * they meet.
 */
export type ReportScope = ExamCode | null;

/** A scope code — from a URL or from settings — as a scope. */
function scopeFromCode(code: ReportScopeCode): ReportScope {
  return code === FULL_SESSION ? null : code;
}

/**
 * Reads `?exam=` into a scope, falling back to whatever the school has configured.
 *
 * One definition because both card pages ask it and they must agree: a link shared from
 * the single-student page and one shared from the class run are the same URL shape, so a
 * page that read a missing parameter differently would print a different card from the
 * same address.
 *
 * Anything unrecognised falls back the same way an absent one does — a mistyped paper is
 * a mistyped paper, not a request for all six.
 */
export function scopeFromParam(exam: string | null, fallback: ReportScopeCode): ReportScope {
  const known = REPORT_SCOPE_CODES.includes(exam as ReportScopeCode);
  return scopeFromCode(known ? (exam as ReportScopeCode) : fallback);
}

/** The `?exam=` value for a scope — the inverse of `scopeFromParam`. */
export function scopeToParam(scope: ReportScope): ReportScopeCode {
  return scope ?? FULL_SESSION;
}
