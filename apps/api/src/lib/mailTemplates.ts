/**
 * The bodies of every email the app sends.
 *
 * Kept out of the auth service so that changing wording does not mean touching token
 * logic, and so both templates share one escaping helper rather than each growing their
 * own.
 */

import {
  PAYMENT_MODE_LABELS,
  classLabel,
  formatINR,
  periodLabel,
  type PaymentMode,
} from '@rntps/shared';

export interface MailBody {
  subject: string;
  text: string;
  html: string;
}

/** Minimal escaping for the values interpolated into the HTML body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Renders "45 minutes", "1 hour", "3 days" — whichever reads naturally for the TTL. */
function describeValidity(minutes: number): string {
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minutes`;
}

/** Sent when someone asks to reset a password they have forgotten. */
export function passwordResetEmail(name: string, link: string, ttlMinutes: number): MailBody {
  const validity = describeValidity(ttlMinutes);

  return {
    subject: 'Reset your RNTPS Admin password',
    text: [
      `Hello ${name},`,
      '',
      'Use this link to set a new password:',
      link,
      '',
      `The link expires in ${validity} and can be used once.`,
      'If you did not ask for this, you can ignore this email — nothing has changed.',
    ].join('\n'),
    html: [
      `<p>Hello ${escapeHtml(name)},</p>`,
      '<p>Use this link to set a new password:</p>',
      `<p><a href="${escapeHtml(link)}">Set a new password</a></p>`,
      `<p style="color:#475569;font-size:14px">The link expires in ${validity} and can be used once. `,
      'If you did not ask for this, you can ignore this email — nothing has changed.</p>',
    ].join(''),
  };
}

/**
 * Sent when an admin creates an account, or resets one on the holder's behalf.
 *
 * Deliberately never contains a password: the recipient chooses their own through the
 * link, so no readable credential exists to be forwarded, overheard or screenshotted.
 */
export function invitationEmail(name: string, link: string, ttlMinutes: number): MailBody {
  const validity = describeValidity(ttlMinutes);

  return {
    subject: 'Set up your RNTPS Admin account',
    text: [
      `Hello ${name},`,
      '',
      'An account has been created for you on RNTPS Admin.',
      'Use this link to choose your password and sign in:',
      link,
      '',
      `The link expires in ${validity} and can be used once.`,
      'Nobody else can see the password you choose — not even an administrator.',
    ].join('\n'),
    html: [
      `<p>Hello ${escapeHtml(name)},</p>`,
      '<p>An account has been created for you on RNTPS Admin. Use this link to choose your password and sign in:</p>',
      `<p><a href="${escapeHtml(link)}">Set your password</a></p>`,
      `<p style="color:#475569;font-size:14px">The link expires in ${validity} and can be used once. `,
      'Nobody else can see the password you choose — not even an administrator.</p>',
    ].join(''),
  };
}

const MONTH_ABBREVIATIONS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * "2026-09-04" -> "4 Sep 2026".
 *
 * A lookup table rather than `Intl`, for the same reason `periodLabel` in shared uses one:
 * a dateKey is a bare calendar day with no time, so building a Date to format it would
 * drag a timezone into a value that has none and render the wrong day west of UTC.
 */
function formatDateKey(dateKey: string): string {
  const month = MONTH_ABBREVIATIONS[Number(dateKey.slice(5, 7)) - 1];
  if (!month) return dateKey;
  return `${Number(dateKey.slice(8, 10))} ${month} ${dateKey.slice(0, 4)}`;
}

function modeLabel(mode: string): string {
  return PAYMENT_MODE_LABELS[mode as PaymentMode] ?? mode;
}

/** One collected payment, as the daily report needs it. */
export interface CollectionEmailRow {
  receiptNo: string;
  studentName: string;
  classCode: string;
  mode: string;
  amountRupees: number;
  isReversed: boolean;
}

// Inline on every cell, never a <style> block: Gmail strips embedded CSS, and it ignores
// :nth-child, so the striping below is computed per row instead.
const CELL = 'padding:8px;border:1px solid #e2e8f0';
const HEAD_CELL = `${CELL};background:#0f172a;color:#ffffff;font-weight:600`;

/**
 * The 7pm summary of one day's fee collection.
 *
 * Typed structurally rather than against the reports module's `CollectionReport`, so this
 * file keeps depending on nothing but shared — `lib/` imports from `modules/` nowhere else
 * either, and a `CollectionRow[]` satisfies this shape as it stands.
 *
 * Reversed receipts are listed but struck through and left out of the total, matching what
 * `getCollectionReport` counts and what the Collection screen already shows. A receipt in a
 * parent's hands should never vanish from the day it was written, and should never be
 * counted as money the school kept — the two rules pull in opposite directions, and this is
 * where they meet.
 */
export function dailyCollectionEmail(input: {
  dateKey: string;
  rows: CollectionEmailRow[];
  totals: { count: number; amountRupees: number };
}): MailBody {
  const day = formatDateKey(input.dateKey);
  const total = formatINR(input.totals.amountRupees);
  const receipts = `${input.totals.count} ${input.totals.count === 1 ? 'receipt' : 'receipts'}`;
  const empty = input.rows.length === 0;

  // Says plainly what the digest can and cannot see. `paidAt` is backdatable and this
  // email goes out at 7pm, so a late or backdated entry is missing from every digest, not
  // merely from this one — the screen is the record, this is a snapshot of it.
  const caveat =
    `Covers payments dated ${day}. Anything recorded after this email went out, or ` +
    'backdated to another day, is not included — Reports → Collection in the app is the ' +
    'full picture.';

  return {
    subject: `Fees collected ${day} — ${empty ? 'nothing recorded' : total}`,
    text: [
      `Fees collected — ${day}`,
      '',
      // Pipe-delimited rather than padded into columns: a plain-text client is not
      // guaranteed to use a monospace font, so padding misaligns rather than aligns.
      ...(empty
        ? ['No payments were recorded on this day.']
        : input.rows.map((row) =>
            [
              row.receiptNo,
              row.studentName,
              classLabel(row.classCode),
              modeLabel(row.mode),
              `${formatINR(row.amountRupees)}${row.isReversed ? ' (reversed)' : ''}`,
            ].join(' | '),
          )),
      '',
      `Total: ${total} across ${receipts}`,
      '',
      caveat,
    ].join('\n'),
    html: [
      `<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#0f172a">Fees collected — <strong>${escapeHtml(day)}</strong></p>`,
      empty
        ? '<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#475569">No payments were recorded on this day.</p>'
        : [
            '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#0f172a">',
            '<thead><tr>',
            `<th scope="col" style="${HEAD_CELL};text-align:left">Receipt</th>`,
            `<th scope="col" style="${HEAD_CELL};text-align:left">Student</th>`,
            `<th scope="col" style="${HEAD_CELL};text-align:left">Class</th>`,
            `<th scope="col" style="${HEAD_CELL};text-align:left">Mode</th>`,
            `<th scope="col" style="${HEAD_CELL};text-align:right">Amount</th>`,
            '</tr></thead><tbody>',
            ...input.rows.map((row, index) =>
              [
                `<tr style="background:${index % 2 === 0 ? '#ffffff' : '#f8fafc'}">`,
                `<td style="${CELL};font-family:monospace">${escapeHtml(row.receiptNo)}</td>`,
                `<td style="${CELL}">${escapeHtml(row.studentName)}</td>`,
                `<td style="${CELL}">${escapeHtml(classLabel(row.classCode))}</td>`,
                `<td style="${CELL}">${escapeHtml(modeLabel(row.mode))}</td>`,
                `<td style="${CELL};text-align:right">${
                  row.isReversed
                    ? // Spelled out as well as struck through: colour and strikethrough
                      // both disappear in a client that strips styles, and neither says
                      // anything to a screen reader.
                      `<span style="text-decoration:line-through;color:#94a3b8">${escapeHtml(formatINR(row.amountRupees))}</span> <span style="color:#b45309;font-size:12px">reversed</span>`
                    : escapeHtml(formatINR(row.amountRupees))
                }</td>`,
                '</tr>',
              ].join(''),
            ),
            '</tbody><tfoot>',
            `<tr style="background:#f1f5f9;font-weight:bold">`,
            `<td colspan="4" style="${CELL};text-align:right">Total — ${escapeHtml(receipts)}</td>`,
            `<td style="${CELL};text-align:right">${escapeHtml(total)}</td>`,
            '</tr></tfoot></table>',
          ].join(''),
      empty
        ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#0f172a"><strong>Total: ${escapeHtml(total)}</strong></p>`
        : '',
      `<p style="font-family:Arial,Helvetica,sans-serif;color:#475569;font-size:12px">${escapeHtml(caveat)}</p>`,
    ].join(''),
  };
}

/**
 * The month-end summary of what the school spent, and how that sat against what it took in.
 *
 * Same inline-styled table as the daily collection email, for the same reason: Gmail strips
 * `<style>` blocks and ignores `:nth-child`, so striping is computed per row here.
 */
export function monthlyExpensesEmail(input: {
  month: string;
  items: { dateKey: string; name: string; amountRupees: number }[];
  totalRupees: number;
  collectedRupees: number;
}): MailBody {
  const label = periodLabel(input.month);
  const spent = formatINR(input.totalRupees);
  const collected = formatINR(input.collectedRupees);
  const net = input.collectedRupees - input.totalRupees;
  // Named in words rather than left to a minus sign, which a mail client may render in a
  // colour the reader cannot see, or strip along with the styling.
  const verdict = `${net >= 0 ? 'profit' : 'loss'} ${formatINR(Math.abs(net))}`;
  const empty = input.items.length === 0;

  // Worded to fit both senders: the month-end schedule and the Send button on the Expenses
  // tab, which can fire at any point in a month. Claiming it went out on the last day would
  // be a lie half the time.
  const caveat =
    `Covers what was recorded for ${label} at the moment this was sent. Anything entered ` +
    'afterwards is in the app but not in this email — Reports → Expenses is the live view.';

  return {
    subject: `Expenses for ${label} — ${spent}`,
    text: [
      `Expenses — ${label}`,
      '',
      ...(empty
        ? ['No expenses were recorded for this month.']
        : input.items.map(
            (item) =>
              `${formatDateKey(item.dateKey)} | ${item.name} | ${formatINR(item.amountRupees)}`,
          )),
      '',
      `Total spent: ${spent}`,
      `Collected: ${collected}`,
      `Overall: ${verdict}`,
      '',
      caveat,
    ].join('\n'),
    html: [
      `<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#0f172a">Expenses — <strong>${escapeHtml(label)}</strong></p>`,
      empty
        ? '<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#475569">No expenses were recorded for this month.</p>'
        : [
            '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#0f172a">',
            '<thead><tr>',
            `<th scope="col" style="${HEAD_CELL};text-align:left">Date</th>`,
            `<th scope="col" style="${HEAD_CELL};text-align:left">What for</th>`,
            `<th scope="col" style="${HEAD_CELL};text-align:right">Amount</th>`,
            '</tr></thead><tbody>',
            ...input.items.map((item, index) =>
              [
                `<tr style="background:${index % 2 === 0 ? '#ffffff' : '#f8fafc'}">`,
                `<td style="${CELL};white-space:nowrap">${escapeHtml(formatDateKey(item.dateKey))}</td>`,
                `<td style="${CELL}">${escapeHtml(item.name)}</td>`,
                `<td style="${CELL};text-align:right">${escapeHtml(formatINR(item.amountRupees))}</td>`,
                '</tr>',
              ].join(''),
            ),
            '</tbody><tfoot>',
            '<tr style="background:#f1f5f9;font-weight:bold">',
            `<td colspan="2" style="${CELL};text-align:right">Total spent</td>`,
            `<td style="${CELL};text-align:right">${escapeHtml(spent)}</td>`,
            '</tr></tfoot></table>',
          ].join(''),
      `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a">Collected ${escapeHtml(collected)} · spent ${escapeHtml(spent)} · <strong>${escapeHtml(verdict)}</strong></p>`,
      `<p style="font-family:Arial,Helvetica,sans-serif;color:#475569;font-size:12px">${escapeHtml(caveat)}</p>`,
    ].join(''),
  };
}
