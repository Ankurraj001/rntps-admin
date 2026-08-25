import {
  CLASS_CODES,
  CONCESSION_TYPES,
  GENDERS,
  GUARDIAN_RELATIONS,
  STUDENT_STATUSES,
  type ClassCode,
  type ConcessionType,
  type Gender,
  type GuardianRelation,
  type StudentStatus,
} from '@rntps/shared';
import { Schema, model, type HydratedDocument } from 'mongoose';

export interface GuardianSub {
  name: string;
  relation: GuardianRelation;
  phone: string;
  isPrimary: boolean;
  whatsappOptOut: boolean;
}

export interface StudentChargeSub {
  id: string;
  name: string;
  amountRupees: number;
  addedAt: Date;
  addedBy: string | null;
}

export interface StudentDoc {
  /** The primary key IS the studentId, e.g. "RNTPS-26-001". */
  _id: string;
  fullName: string;
  dob: string;
  gender: Gender;
  classCode: ClassCode;
  rollNo: number | null;
  admissionDate: string;
  /** Stored in full, digits only. */
  aadhaar: string | null;
  /** APAAR ID / Permanent Education Number. */
  apaarId: string | null;
  status: StudentStatus;
  academicYear: string;
  /** Siblings share this key; it is the whole sibling implementation. */
  familyId: string;
  guardians: GuardianSub[];
  address: { line1: string; line2: string; city: string; state: string; pincode: string };
  transportOpted: boolean;
  /** Per-student transport fare in whole rupees. Null means use the class default. */
  transportFareOverrideRupees: number | null;
  /**
   * Charges waiting to be billed — arrears, fines, exam fees.
   *
   * They stay here until a monthly invoice absorbs them as line items, which is what
   * keeps a student to one invoice per month. Entries are never removed: whether a charge
   * has been billed is read from the invoices that reference its id, so the two can never
   * disagree.
   */
  charges: StudentChargeSub[];
  concession: { type: ConcessionType; value: number; reason: string };
  photoUrl: string | null;
  notes: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const guardianSchema = new Schema<GuardianSub>(
  {
    name: { type: String, required: true, trim: true },
    relation: { type: String, enum: GUARDIAN_RELATIONS, required: true },
    // Stored as 91XXXXXXXXXX so it can be dropped straight into a wa.me link.
    phone: { type: String, required: true, match: /^91[6-9]\d{9}$/ },
    isPrimary: { type: Boolean, default: false },
    whatsappOptOut: { type: Boolean, default: false },
  },
  { _id: false },
);

const studentSchema = new Schema<StudentDoc>(
  {
    _id: { type: String, required: true, uppercase: true, trim: true },
    fullName: { type: String, required: true, trim: true, maxlength: 80 },
    dob: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    gender: { type: String, enum: GENDERS, required: true },
    classCode: { type: String, enum: CLASS_CODES, required: true },
    rollNo: { type: Number, default: null, min: 1, max: 999 },
    admissionDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    aadhaar: { type: String, default: null, match: /^\d{12}$/ },
    apaarId: { type: String, default: null, uppercase: true, trim: true },
    status: { type: String, enum: STUDENT_STATUSES, default: 'ACTIVE', required: true },
    academicYear: { type: String, required: true },
    familyId: { type: String, required: true },
    guardians: { type: [guardianSchema], required: true, validate: [
      (value: GuardianSub[]) => value.length >= 1 && value.length <= 4,
      'A student needs between 1 and 4 guardians',
    ] },
    address: {
      line1: { type: String, default: '', trim: true },
      line2: { type: String, default: '', trim: true },
      city: { type: String, default: '', trim: true },
      state: { type: String, default: '', trim: true },
      pincode: { type: String, default: '', trim: true },
    },
    transportOpted: { type: Boolean, default: false },
    charges: {
      type: [
        {
          _id: false,
          id: { type: String, required: true },
          name: { type: String, required: true, trim: true },
          amountRupees: { type: Number, required: true, min: 1, validate: Number.isInteger },
          addedAt: { type: Date, required: true },
          addedBy: { type: String, default: null },
        },
      ],
      default: [],
    },
    transportFareOverrideRupees: { type: Number, default: null, min: 0, validate: {
      validator: (value: number | null) => value === null || Number.isInteger(value),
      message: 'Transport fare must be a whole number of rupees',
    } },
    concession: {
      type: { type: String, enum: CONCESSION_TYPES, default: 'NONE' },
      value: { type: Number, default: 0, min: 0 },
      reason: { type: String, default: '', trim: true },
    },
    photoUrl: { type: String, default: null },
    notes: { type: String, default: '', maxlength: 1000 },
    createdBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, _id: false },
);

studentSchema.index({ familyId: 1 });
studentSchema.index({ classCode: 1, status: 1, rollNo: 1 });
studentSchema.index({ 'guardians.phone': 1 });
studentSchema.index({ fullName: 'text' });
/**
 * Both government IDs must be unique across the school — the same Aadhaar on two records
 * means a duplicate student.
 *
 * A partial filter, not a sparse index: sparse skips documents *missing* the field, but a
 * field explicitly set to null is still indexed, so every student without an Aadhaar
 * would collide with every other. Filtering on $type: 'string' indexes only the ones
 * that actually have a value.
 */
studentSchema.index(
  { aadhaar: 1 },
  { unique: true, partialFilterExpression: { aadhaar: { $type: 'string' } } },
);
studentSchema.index(
  { apaarId: 1 },
  { unique: true, partialFilterExpression: { apaarId: { $type: 'string' } } },
);

// Roll numbers only need to be unique among the students actually sitting in a class.
studentSchema.index(
  { classCode: 1, academicYear: 1, rollNo: 1 },
  { unique: true, partialFilterExpression: { rollNo: { $type: 'number' }, status: 'ACTIVE' } },
);

export const Student = model<StudentDoc>('Student', studentSchema);
export type StudentHydrated = HydratedDocument<StudentDoc>;
