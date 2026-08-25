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
