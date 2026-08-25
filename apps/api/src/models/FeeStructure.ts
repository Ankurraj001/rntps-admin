import { CLASS_CODES, FEE_HEAD_SCOPES, type ClassCode, type FeeHeadScope } from '@rntps/shared';
import { Schema, model } from 'mongoose';

export interface FeeHeadSub {
  code: string;
  name: string;
  amountRupees: number;
  appliesTo: FeeHeadScope;
}

export interface FeeStructureDoc {
  /** `{classCode}:{academicYear}`, e.g. "5:2026-27" — one structure per class per year. */
  _id: string;
  classCode: ClassCode;
  academicYear: string;
  heads: FeeHeadSub[];
  createdAt: Date;
  updatedAt: Date;
}

const feeHeadSchema = new Schema<FeeHeadSub>(
  {
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    // Integer rupees. Floats would accumulate rounding errors across a year of invoices.
    amountRupees: { type: Number, required: true, min: 0, validate: Number.isInteger },
    appliesTo: { type: String, enum: FEE_HEAD_SCOPES, default: 'ALL' },
  },
  { _id: false },
);

const feeStructureSchema = new Schema<FeeStructureDoc>(
  {
    _id: { type: String, required: true },
    classCode: { type: String, enum: CLASS_CODES, required: true },
    academicYear: { type: String, required: true },
    heads: { type: [feeHeadSchema], required: true },
  },
  { timestamps: true, versionKey: false, _id: false },
);

feeStructureSchema.index({ academicYear: 1, classCode: 1 });

export const FeeStructure = model<FeeStructureDoc>('FeeStructure', feeStructureSchema);

export function feeStructureId(classCode: string, academicYear: string): string {
  return `${classCode}:${academicYear}`;
}
