/** The school's fixed class list. There are no sections. */
export const CLASS_CODES = [
  'NURSERY',
  'LKG',
  'UKG',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
] as const;

export type ClassCode = (typeof CLASS_CODES)[number];

/** Display label for a class code, e.g. "5" -> "Class 5". */
export function classLabel(code: ClassCode | string): string {
  switch (code) {
    case 'NURSERY':
      return 'Nursery';
    case 'LKG':
      return 'LKG';
    case 'UKG':
      return 'UKG';
    default:
      return `Class ${code}`;
  }
}

/**
 * Ordered promotion map used at year rollover. Class 8 is the terminal class —
 * those students become alumni rather than moving up.
 */
export function nextClassCode(code: ClassCode): ClassCode | null {
  const index = CLASS_CODES.indexOf(code);
  if (index === -1 || index === CLASS_CODES.length - 1) return null;
  return CLASS_CODES[index + 1] ?? null;
}

export const STUDENT_STATUSES = ['ACTIVE', 'INACTIVE', 'TC_ISSUED', 'ALUMNI'] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export const GENDERS = ['MALE', 'FEMALE', 'OTHER'] as const;
export type Gender = (typeof GENDERS)[number];

export const GUARDIAN_RELATIONS = ['FATHER', 'MOTHER', 'GUARDIAN'] as const;
export type GuardianRelation = (typeof GUARDIAN_RELATIONS)[number];

export const CONCESSION_TYPES = ['NONE', 'PERCENT', 'FLAT'] as const;
export type ConcessionType = (typeof CONCESSION_TYPES)[number];

export const USER_ROLES = ['ADMIN', 'TEACHER'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Three states, deliberately. A child was either in school or not; a holiday is not a
 * school day at all. Finer grades — late, on leave — asked the teacher marking 30 names
 * to make a judgement call every morning, and nothing downstream treated them
 * differently from present or absent anyway.
 */
export const ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'HOLIDAY'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const ATTENDANCE_LABELS: Record<AttendanceStatus, string> = {
  PRESENT: 'Present',
  ABSENT: 'Absent',
  HOLIDAY: 'Holiday',
};

/** Single letter used in the dense monthly grid. */
export const ATTENDANCE_SHORT: Record<AttendanceStatus, string> = {
  PRESENT: 'P',
  ABSENT: 'A',
  HOLIDAY: 'H',
};

/** Counts toward the attendance percentage numerator. */
export function countsAsPresent(status: AttendanceStatus): boolean {
  return status === 'PRESENT';
}

/** Holidays are excluded from the denominator — they are not working days. */
export function countsAsWorkingDay(status: AttendanceStatus): boolean {
  return status !== 'HOLIDAY';
}

export const INVOICE_STATUSES = ['DUE', 'PARTIAL', 'PAID', 'VOID'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * How an invoice came to exist.
 *
 * MONTHLY invoices come from the fee-structure run and are keyed `{studentId}:{period}`,
 * which is what makes billing a class twice for one month structurally impossible.
 * ADHOC invoices are raised by hand for one student — an opening balance, an exam fee, a
 * fine — and carry their own key, so a student can have several in the same month.
 *
 * The distinction is load-bearing: the monthly run asks "has this student been invoiced
 * for this period?" and must count only MONTHLY invoices. Counting an ad-hoc fine would
 * make the run skip that student and silently never bill their tuition.
 */
export const INVOICE_KINDS = ['MONTHLY', 'ADHOC'] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export const PAYMENT_MODES = ['CASH', 'UPI', 'CHEQUE', 'BANK'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  CASH: 'Cash',
  UPI: 'UPI',
  CHEQUE: 'Cheque',
  BANK: 'Bank transfer',
};

/** Which students a fee head applies to. */
export const FEE_HEAD_SCOPES = ['ALL', 'TRANSPORT_OPTED'] as const;
export type FeeHeadScope = (typeof FEE_HEAD_SCOPES)[number];
