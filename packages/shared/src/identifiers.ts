/**
 * Aadhaar and APAAR/PEN handling.
 *
 * Aadhaar carries a Verhoeff check digit, which is worth verifying: it catches every
 * single-digit typo and every transposition of adjacent digits, and a hand-typed
 * 12-digit number gets both wrong regularly.
 */

// Multiplication table for the dihedral group D5.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;

// Permutation applied by position, cycling every 8 digits.
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;

const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9] as const;

function digitsOf(value: string): number[] | null {
  const cleaned = value.replace(/\D/g, '');
  if (cleaned.length === 0) return null;
  return [...cleaned].map(Number);
}

/** True when the trailing Verhoeff check digit is consistent with the rest. */
export function isValidVerhoeff(value: string): boolean {
  const digits = digitsOf(value);
  if (!digits) return false;

  let checksum = 0;
  for (const [index, digit] of [...digits].reverse().entries()) {
    checksum = D[checksum]![P[index % 8]![digit]!]!;
  }
  return checksum === 0;
}

/** The check digit that makes `payload` a valid Verhoeff number. */
export function verhoeffCheckDigit(payload: string): number {
  const digits = digitsOf(payload) ?? [];

  let checksum = 0;
  for (const [index, digit] of [...digits].reverse().entries()) {
    checksum = D[checksum]![P[(index + 1) % 8]![digit]!]!;
  }
  return INV[checksum]!;
}

/** Strips spaces and hyphens, the way Aadhaar is normally written on paper. */
export function normaliseAadhaar(value: string): string {
  return value.replace(/[\s-]/g, '');
}

export function isValidAadhaar(value: string): boolean {
  const cleaned = normaliseAadhaar(value);
  if (!/^\d{12}$/.test(cleaned)) return false;
  // UIDAI never issues a number beginning 0 or 1.
  if (cleaned[0] === '0' || cleaned[0] === '1') return false;
  return isValidVerhoeff(cleaned);
}

/** Groups into 4s for display, as printed on the card: "2345 6789 0123". */
export function formatAadhaar(value: string): string {
  const cleaned = normaliseAadhaar(value);
  return cleaned.replace(/(\d{4})(?=\d)/g, '$1 ');
}

/**
 * Last four digits only, in the form UIDAI expects wherever a full number should not
 * appear. Not used for the student page — that shows the number in full — but kept for
 * anywhere a masked form is wanted later.
 */
export function maskAadhaar(value: string): string {
  const cleaned = normaliseAadhaar(value);
  if (cleaned.length < 4) return 'XXXX XXXX XXXX';
  return `XXXX XXXX ${cleaned.slice(-4)}`;
}

/**
 * APAAR ID / Permanent Education Number.
 *
 * Deliberately permissive: the format varies by state and by whether the school is on
 * APAAR or an older UDISE+ PEN scheme, and rejecting a valid government ID because this
 * app guessed the wrong length is worse than accepting a typo.
 */
export function normaliseApaarId(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

export function isValidApaarId(value: string): boolean {
  return /^[A-Z0-9]{8,20}$/.test(normaliseApaarId(value));
}
