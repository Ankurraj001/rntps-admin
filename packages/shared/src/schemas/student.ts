import { z } from 'zod';
import {
  CLASS_CODES,
  CONCESSION_TYPES,
  GENDERS,
  GUARDIAN_RELATIONS,
  STUDENT_STATUSES,
} from '../constants.js';
import { isValidDateKey } from '../date.js';
import {
  isValidAadhaar,
  isValidApaarId,
  normaliseAadhaar,
  normaliseApaarId,
} from '../identifiers.js';
import {
  clearableText,
  optionalText,
  paginationSchema,
  phoneInputSchema,
  pincodeSchema,
} from './common.js';

/** Calendar days (DOB, admission date) travel as "YYYY-MM-DD" for the same reason attendance does. */
const dateKeyField = z
  .string()
  .refine(isValidDateKey, 'Enter a valid date')
  .describe('YYYY-MM-DD');

export const guardianSchema = z.object({
  name: z.string().trim().min(2, 'Guardian name is required').max(80),
  relation: z.enum(GUARDIAN_RELATIONS),
  phone: phoneInputSchema,
  isPrimary: z.boolean().default(false),
  whatsappOptOut: z.boolean().default(false),
});

export const addressSchema = z.object({
  line1: z.string().trim().max(120).default(''),
  line2: z.string().trim().max(120).default(''),
  city: z.string().trim().max(60).default(''),
  state: z.string().trim().max(60).default(''),
  pincode: z.union([pincodeSchema, z.literal('')]).default(''),
});

/**
 * A charge attached to one student — arrears, an exam fee, a trip, a fine.
 *
 * It is *not* an invoice. It waits on the student's record until the next monthly invoice
 * run absorbs it as a line item, so a student never has more than one invoice per month.
 */
export const addChargeSchema = z.object({
  name: z.string().trim().min(2, 'Say what the charge is for').max(60),
  amountRupees: z.number().int().min(1, 'Enter an amount').max(1_000_000),
});

export type AddChargePayload = z.output<typeof addChargeSchema>;

export interface StudentChargeDto {
  id: string;
  name: string;
  amountRupees: number;
  addedAt: string;
  /** Set once a monthly invoice has absorbed it; null while it is still waiting. */
  billedOnInvoiceId: string | null;
  billedPeriod: string | null;
}

export const concessionSchema = z
  .object({
    type: z.enum(CONCESSION_TYPES).default('NONE'),
    /** PERCENT -> 0-100 (may be fractional). FLAT -> whole rupees. NONE -> 0. */
    value: z.number().min(0).max(1_000_000).default(0),
    reason: z.string().trim().max(200).default(''),
  })
  .superRefine((concession, ctx) => {
    if (concession.type === 'NONE' && concession.value !== 0) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Value must be 0 when there is no concession' });
    }
    if (concession.type === 'PERCENT' && concession.value > 100) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Percentage cannot exceed 100' });
    }
    if (concession.type !== 'NONE' && concession.value <= 0) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Enter a concession amount' });
    }
    // A flat concession is money, so it follows the same whole-rupee rule as every other
    // amount. A percentage may be fractional — 12.5% is a real thing a school offers.
    if (concession.type === 'FLAT' && !Number.isInteger(concession.value)) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Enter a whole number of rupees',
      });
    }
  });

export const createStudentSchema = z
  .object({
    /** Optional override so the school can keep its existing admission numbers. */
    studentId: optionalText(
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9][A-Z0-9-]{2,29}$/, 'Use letters, digits and hyphens (3-30 characters)'),
    ),
    fullName: z.string().trim().min(2, 'Full name is required').max(80),
    dob: dateKeyField,
    gender: z.enum(GENDERS),
    classCode: z.enum(CLASS_CODES),
    rollNo: z.number().int().min(1).max(999).nullable().default(null),
    admissionDate: dateKeyField,
    /**
     * Aadhaar. Validated against its Verhoeff check digit, which catches every
     * single-digit typo and every transposition of adjacent digits — both common when
     * copying twelve digits off a card by hand.
     */
    aadhaar: optionalText(
      z
        .string()
        .transform(normaliseAadhaar)
        .refine(isValidAadhaar, 'Enter a valid 12-digit Aadhaar number'),
    ),
    /**
     * APAAR ID / Permanent Education Number. Deliberately loose: the format differs by
     * state and by whether the school is on APAAR or an older UDISE+ PEN scheme, and
     * rejecting a valid government ID on a guess is worse than accepting a typo.
     */
    apaarId: optionalText(
      z
        .string()
        .transform(normaliseApaarId)
        .refine(isValidApaarId, 'Use 8 to 20 letters or digits'),
    ),
    /**
     * When set, the new student joins this student's family: they inherit the same
     * familyId instead of getting a new one. This is how siblings are linked.
     */
    siblingOfStudentId: optionalText(z.string().trim().toUpperCase()),
    guardians: z.array(guardianSchema).min(1, 'At least one guardian is required').max(4),
    address: addressSchema.default({}),
    transportOpted: z.boolean().default(false),
    /**
     * Replaces the class's transport fee for this student, in whole rupees.
     *
     * Null means "use the class default", which is the normal case. Set it for a child
     * whose fare differs — by distance, by stop, by arrangement — without touching the
     * class fee structure or anyone else.
     *
     * Only billed when transportOpted is true: the checkbox decides *whether* transport
     * is charged, this decides *how much*.
     */
    transportFareOverrideRupees: z.number().int().min(0).max(1_000_000).nullable().default(null),
    concession: concessionSchema.default({ type: 'NONE', value: 0, reason: '' }),
    notes: z.string().trim().max(1000).default(''),
  })
  .superRefine((student, ctx) => {
    if (student.dob >= student.admissionDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['dob'],
        message: 'Date of birth must be before the admission date',
      });
    }
    checkGuardians(student.guardians, ctx);
  });

/**
 * Shared so create and update enforce the same rules.
 *
 * These live in a superRefine rather than on the field, and `updateStudentSchema` is
 * built with `.innerType()` — which unwraps the effect and would silently drop them.
 * Calling this from both places is what stops an edit saving a student with no primary
 * contact.
 */
function checkGuardians(guardians: Guardian[], ctx: z.RefinementCtx): void {
  const primaryCount = guardians.filter((g) => g.isPrimary).length;
  if (primaryCount !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['guardians'],
      message: 'Mark exactly one guardian as the primary WhatsApp contact',
    });
  }

  const phones = guardians.map((g) => g.phone);
  if (new Set(phones).size !== phones.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['guardians'],
      message: 'Guardian phone numbers must be different',
    });
  }
}

/** Edits cannot change the studentId (it is the primary key) or re-parent the family. */
export const updateStudentSchema = createStudentSchema
  .innerType()
  .omit({ studentId: true, siblingOfStudentId: true })
  .partial()
  .extend({
    guardians: z.array(guardianSchema).min(1).max(4).optional(),
    // Clearable rather than merely optional: an identifier entered against the wrong
    // student has to be removable, or its uniqueness locks out the right one.
    aadhaar: clearableText(
      z
        .string()
        .transform(normaliseAadhaar)
        .refine(isValidAadhaar, 'Enter a valid 12-digit Aadhaar number'),
    ),
    apaarId: clearableText(
      z
        .string()
        .transform(normaliseApaarId)
        .refine(isValidApaarId, 'Use 8 to 20 letters or digits'),
    ),
    // Explicitly nullable so an override can be removed and the class default restored.
    transportFareOverrideRupees: z.number().int().min(0).max(1_000_000).nullable().optional(),
  })
  .superRefine((student, ctx) => {
    // Only when the caller actually sends them: a partial update that omits guardians
    // must not be rejected for saying nothing about them.
    if (student.guardians) checkGuardians(student.guardians, ctx);

    if (student.dob && student.admissionDate && student.dob >= student.admissionDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['dob'],
        message: 'Date of birth must be before the admission date',
      });
    }
  });

export const updateStudentStatusSchema = z.object({
  status: z.enum(STUDENT_STATUSES),
  reason: z.string().trim().max(200).default(''),
});

export const listStudentsQuerySchema = paginationSchema.extend({
  /** Matches against full name or studentId. */
  q: z.string().trim().max(80).optional(),
  classCode: z.enum(CLASS_CODES).optional(),
  status: z.enum(STUDENT_STATUSES).optional(),
  familyId: z.string().trim().optional(),
  sort: z.enum(['fullName', 'rollNo', 'createdAt', 'classCode']).default('fullName'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

export const promoteStudentsSchema = z.object({
  fromAcademicYear: z.string().regex(/^\d{4}-\d{2}$/),
  toAcademicYear: z.string().regex(/^\d{4}-\d{2}$/),
  /** Restrict the run to specific classes; omit to promote every active student. */
  classCodes: z.array(z.enum(CLASS_CODES)).optional(),
  dryRun: z.boolean().default(true),
});

export type CreateStudentInput = z.input<typeof createStudentSchema>;
export type CreateStudentPayload = z.output<typeof createStudentSchema>;
export type UpdateStudentPayload = z.output<typeof updateStudentSchema>;
export type ListStudentsQuery = z.output<typeof listStudentsQuerySchema>;
export type Guardian = z.output<typeof guardianSchema>;
export type Address = z.output<typeof addressSchema>;
export type Concession = z.output<typeof concessionSchema>;

/** The student document as the API returns it. */
export interface StudentDto {
  studentId: string;
  fullName: string;
  dob: string;
  gender: (typeof GENDERS)[number];
  classCode: (typeof CLASS_CODES)[number];
  rollNo: number | null;
  admissionDate: string;
  aadhaar: string | null;
  apaarId: string | null;
  status: (typeof STUDENT_STATUSES)[number];
  academicYear: string;
  familyId: string;
  guardians: Guardian[];
  address: Address;
  transportOpted: boolean;
  transportFareOverrideRupees: number | null;
  concession: Concession;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/** A sibling as shown on the Family tab — the same familyId, a different studentId. */
export interface SiblingDto {
  studentId: string;
  fullName: string;
  classCode: string;
  status: string;
}

/**
 * Everything the year-rollover screen needs, in one read.
 *
 * The three levers of a rollover — clone the fee structures, set the new session year,
 * promote the students — are separate endpoints with no shared state, so the only way to
 * know which have been done is to look at their effects. Deriving that on the server keeps
 * the client from guessing, and keeps the answer the same whichever step it is asked after.
 */
export interface RolloverStatusDto {
  /** The session the school is currently operating in, from settings. */
  activeAcademicYear: string;
  /** The session being closed. */
  fromAcademicYear: string;
  /** The session being opened. */
  toAcademicYear: string;
  /**
   * True when no cohort is behind the active year — nothing is mid-rollover, and the pair
   * above describes the *next* one rather than one in progress.
   */
  notStarted: boolean;
  /** Students still on the roll, grouped by the session on their record, oldest first. */
  cohorts: { academicYear: string; count: number }[];
  steps: {
    feeStructuresCloned: boolean;
    academicYearSet: boolean;
    studentsPromoted: boolean;
  };
}
