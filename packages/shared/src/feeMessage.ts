/**
 * Layout for the WhatsApp fee demand — the message a parent gets asking for the month's
 * fee, built to read like the paper fee card they already recognise.
 *
 * This module is deliberately pure: it takes amounts and returns a string, with no
 * database, no settings lookup and no `Date`. All the alignment arithmetic is therefore
 * unit-testable, which matters because a column that drifts by one character is obvious
 * to a parent and invisible in a code review.
 *
 * The table is wrapped in a WhatsApp monospace fence so the amount column lines up.
 * Everything outside the fence — school name, month, the payment-window note — is normal
 * text, because a whole message in monospace renders small and cramped.
 */

import { classLabel } from './constants.js';
import { formatINR } from './money.js';

/**
 * Width of the fee table, in monospace characters.
 *
 * WhatsApp renders a fenced block in monospace but will not scroll it sideways — a line
 * wider than the bubble wraps, and a wrapped line puts the amount on its own row where it
 * lines up with nothing. 26 characters fits the narrowest phone still in use while
 * leaving "Previous dues" enough room to sit beside "₹ 1,00,000".
 */
export const TABLE_WIDTH = 26;

const THIN_RULE = '-'.repeat(TABLE_WIDTH);
const THICK_RULE = '='.repeat(TABLE_WIDTH);
const FENCE = '```';

/**
 * Rules and separators are ASCII on purpose. Box-drawing characters look better but every
 * `─` costs 9 characters once the message is percent-encoded into a `wa.me` URL, so a
 * single 26-wide rule would spend 234 characters of a budget that is already tight for a
 * family with three children.
 */

export interface FeeMessageLine {
  name: string;
  amountRupees: number;
}

export interface FeeMessageChild {
  fullName: string;
  classCode: string;
  /** This period's fee heads and absorbed charges, in invoice order. */
  lines: FeeMessageLine[];
  /** Discount on the fee lines. Shown as a negative row when non-zero. */
  concessionRupees: number;
  /** Everything still owed on older invoices, rolled into one row. Display only. */
  previousDuesRupees: number;
  /** Already paid against this period's invoice, e.g. a part payment. */
  paidRupees: number;
  /** lines − concession + previousDues − paid. What this child actually owes. */
  totalRupees: number;
}

export type FeeSlipMode = 'full' | 'compact';

/** Amounts read "₹ 1,000" on a fee card, not "₹1,000"; negatives lead with the sign. */
function amountText(rupees: number): string {
  const spaced = formatINR(Math.abs(rupees)).replace('₹', '₹ ');
  return rupees < 0 ? `-${spaced}` : spaced;
}

/**
 * One label-and-amount row, right-aligned to `TABLE_WIDTH`.
 *
 * A fee head name may be up to 60 characters (`feeHeadSchema`), which would push the
 * amount off the line, so a long name is truncated rather than allowed to wrap. At least
 * one space always separates the two so they can never merge into "Previous dues₹4,000".
 */
function row(label: string, rupees: number, indent = 0): string {
  const amount = amountText(rupees);
  const prefix = ' '.repeat(indent);
  const room = Math.max(1, TABLE_WIDTH - prefix.length - amount.length - 1);
  const name = label.length > room ? `${label.slice(0, Math.max(1, room - 2))}..` : label;
  const gap = Math.max(1, TABLE_WIDTH - prefix.length - name.length - amount.length);
  return prefix + name + ' '.repeat(gap) + amount;
}

/** "Std. 4", but Nursery, LKG and UKG keep their own names. */
export function stdLabel(classCode: string): string {
  return /^\d+$/.test(classCode) ? `Std. ${classCode}` : classLabel(classCode);
}

/** The value printed after "Std.:" — a bare number, or the name for a pre-primary class. */
function stdValue(classCode: string): string {
  return /^\d+$/.test(classCode) ? classCode : classLabel(classCode);
}

/** The rows for one child: their fee lines, then whatever adjusts them. */
function childRows(child: FeeMessageChild): string[] {
  const rows = child.lines.map((line) => row(line.name, line.amountRupees));

  // A concession comes off the fee lines, so without this row the total contradicts the
  // rows above it. Same for a part payment already received.
  if (child.concessionRupees > 0) rows.push(row('Concession', -child.concessionRupees));
  if (child.previousDuesRupees > 0) rows.push(row('Previous dues', child.previousDuesRupees));
  if (child.paidRupees > 0) rows.push(row('Less paid', -child.paidRupees));

  return rows;
}

/**
 * The fenced fee table.
 *
 * One child gets a named header and a single total. Siblings get a block each with a
 * subtotal, then a family total — a parent with three children is handed one message and
 * one figure to pay, which is the whole point of grouping by phone number.
 *
 * `compact` drops the per-child breakdown and keeps one line per child. It exists only as
 * a fallback for when the itemised version would overflow the `wa.me` URL.
 */
export function buildFeeSlip(
  children: FeeMessageChild[],
  familyTotalRupees: number,
  mode: FeeSlipMode = 'full',
): string {
  const body: string[] = [];
  const [only] = children;

  if (only && children.length === 1 && mode === 'full') {
    body.push(`Name: ${only.fullName}`, `Std.: ${stdValue(only.classCode)}`, THIN_RULE);
    body.push(...childRows(only));
    body.push(THICK_RULE, row('Total payable', only.totalRupees));
  } else if (mode === 'compact') {
    // Bare class code rather than "Std. 4": this form only exists to fit an unusual number
    // of children on one number, and every character spent on the label is one the child's
    // own name loses to truncation.
    body.push(...children.map((child) => row(`${child.fullName} (${child.classCode})`, child.totalRupees)));
    body.push(THICK_RULE, row('FAMILY TOTAL', familyTotalRupees));
  } else {
    children.forEach((child, index) => {
      if (index > 0) body.push(THIN_RULE);
      body.push(`${child.fullName} · ${stdLabel(child.classCode)}`);
      body.push(...childRows(child));
      body.push(row('Subtotal', child.totalRupees, 2));
    });
    body.push(THICK_RULE, row('FAMILY TOTAL', familyTotalRupees));
  }

  return [FENCE, ...body, FENCE].join('\n');
}

/** Ordinal day of the month, for the payment-window note. */
export function ordinalDay(day: number): string {
  // 11th, 12th and 13th break the last-digit rule, which is why they are checked first.
  const teens = day % 100;
  if (teens >= 11 && teens <= 13) return `${day}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] ?? 'th';
  return `${day}${suffix}`;
}
