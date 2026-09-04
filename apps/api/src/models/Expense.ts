import { Schema, model, type Types } from 'mongoose';

/**
 * One thing the school paid for — a salary, a tank of petrol, an electricity bill.
 *
 * Keyed on an ObjectId rather than a meaningful string, joining `notifications` and
 * `auditLogs` on that side of the convention. A readable `_id` exists elsewhere to make
 * duplicates structurally impossible (`{studentId}:{period}` can only be billed once), and
 * expenses have no such rule: two ₹800 petrol entries in one month are two real refuels,
 * so a composite key would reject legitimate rows.
 */
export interface ExpenseDoc {
  _id: Types.ObjectId;
  /** The IST day it was paid. */
  dateKey: string;
  /**
   * The month it belongs to, `YYYY-MM`, always `dateKey.slice(0, 7)`.
   *
   * Stored rather than derived at query time so the month filter is a single indexed
   * equality rather than a range scan. Only ever written from `dateKey` on the server, so
   * the two cannot drift — the client never sends this.
   */
  period: string;
  name: string;
  amountRupees: number;
  recordedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const expenseSchema = new Schema<ExpenseDoc>(
  {
    dateKey: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    period: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    // `min: 1` as well as the integer check — without it, 0 and negatives pass happily.
    amountRupees: { type: Number, required: true, min: 1, validate: Number.isInteger },
    recordedBy: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

// Every read is one month, newest day first.
expenseSchema.index({ period: -1, dateKey: -1 });

export const Expense = model<ExpenseDoc>('Expense', expenseSchema);
