import type { Response } from 'express';

/**
 * Minimal RFC 4180 CSV writer. A dependency is not worth it for this, but the escaping
 * rules matter: a student name containing a comma, or a note containing a newline, would
 * otherwise silently corrupt the file the school opens in Excel.
 */
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCell).join(','));
  // CRLF and a trailing newline: what Excel expects.
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Rupees as a bare integer for spreadsheets — no ₹ symbol, no thousands separators, so
 * Excel reads the cell as a number it can sum rather than as text.
 */
export function rupeesForCsv(rupees: number): string {
  return String(rupees);
}

export function csvFilename(prefix: string, suffix: string): string {
  return `${prefix}-${suffix.replace(/[^\w-]/g, '')}.csv`;
}

/** Sends a CSV as a download. Shared so every export sets the same headers and BOM. */
export function sendCsv(res: Response, filename: string, body: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // Excel needs a byte-order mark to read UTF-8 (student names) correctly. Written as
  // an escape rather than a literal BOM so it is visible in the source.
  res.send(`\uFEFF${body}`);
}
