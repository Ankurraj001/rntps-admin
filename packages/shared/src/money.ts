/**
 * Money is stored everywhere as an integer number of **rupees**, never as a float.
 * `₹1,800` is stored as `1800`.
 *
 * Integer, not decimal, is the important half of that sentence. School fees are always
 * whole rupees, so paise buy nothing here — but floats would still misbehave
 * (`0.1 + 0.2 !== 0.3`), and those errors accumulate across a year of invoices and
 * part-payments. Keeping the unit integral means every sum, concession and balance is
 * exact, and no conversion is needed at the API or UI edges.
 */

/** Formats integer rupees as an Indian-locale currency string, e.g. 180050 -> "₹1,80,050". */
export function formatINR(rupees: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(rupees);
}

/**
 * What the school kept: everything that came in, less what it spent.
 *
 * Lives here rather than at each call site because five surfaces state this number — the
 * Expenses tab's card and its all-time line, the dashboard tile, the month-end email and the
 * daily digest — and an email that disagrees with the screen is the failure nobody catches.
 * It was `collected - spent` in three separate copies before income existed; adding a third
 * term to each of them independently is how they would have drifted.
 */
export function netRupees(input: {
  collectedRupees: number;
  gainRupees: number;
  expenseRupees: number;
}): number {
  return input.collectedRupees + input.gainRupees - input.expenseRupees;
}

/**
 * "profit ₹500" / "loss ₹500" — the sign said in words, not left to a minus sign.
 *
 * Shared with the emails on purpose: a mail client may render a minus sign in a colour the
 * reader cannot see, or strip it along with the styling, so the word is the only reliable
 * carrier of which way the month went.
 */
export function netLabel(net: number): string {
  return `${net >= 0 ? 'profit' : 'loss'} ${formatINR(Math.abs(net))}`;
}
