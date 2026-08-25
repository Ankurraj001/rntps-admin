import {
  TABLE_WIDTH,
  buildFeeSlip,
  fitWaMessage,
  ordinalDay,
  periodLabel,
  stdLabel,
  waUrlFits,
  type FeeMessageChild,
} from '@rntps/shared';
import { describe, expect, it } from 'vitest';

function child(over: Partial<FeeMessageChild> = {}): FeeMessageChild {
  const base: FeeMessageChild = {
    fullName: 'Aarav Sharma',
    classCode: '4',
    lines: [{ name: 'Tuition Fee', amountRupees: 1_000 }],
    concessionRupees: 0,
    previousDuesRupees: 0,
    paidRupees: 0,
    totalRupees: 1_000,
  };
  return { ...base, ...over };
}

/** The amount on a row, as a plain signed number — "Concession  -₹ 200" -> -200. */
function amountOf(line: string): number {
  const match = /(-?)₹ ([\d,]+)$/.exec(line);
  if (!match) throw new Error(`no amount on "${line}"`);
  return Number(match[2]?.replace(/,/g, '')) * (match[1] === '-' ? -1 : 1);
}

const rowsOf = (slip: string) => slip.split('\n').filter((line) => /₹/.test(line));

describe('buildFeeSlip — one child', () => {
  it('reads like a fee card: name, class, a line per head, one total', () => {
    const slip = buildFeeSlip([child()], 1_000);

    expect(slip.split('\n')).toEqual([
      '```',
      'Name: Aarav Sharma',
      'Std.: 4',
      '-'.repeat(TABLE_WIDTH),
      'Tuition Fee        ₹ 1,000',
      '='.repeat(TABLE_WIDTH),
      'Total payable      ₹ 1,000',
      '```',
    ]);
  });

  it('names the pre-primary classes rather than numbering them', () => {
    expect(buildFeeSlip([child({ classCode: 'NURSERY' })], 1_000)).toContain('Std.: Nursery');
    expect(buildFeeSlip([child({ classCode: 'LKG' })], 1_000)).toContain('Std.: LKG');
  });

  it('shows every head and absorbed charge under its own name', () => {
    const slip = buildFeeSlip(
      [
        child({
          lines: [
            { name: 'Tuition Fee', amountRupees: 1_000 },
            { name: 'Transport fee', amountRupees: 700 },
            { name: 'Exam fee', amountRupees: 100 },
            { name: 'Fine', amountRupees: 50 },
          ],
          totalRupees: 1_850,
        }),
      ],
      1_850,
    );

    // "Exam fee" and "Fine" are student charges, not fee heads — they arrive as line items
    // carrying their own name, so no canonical list of heads is needed anywhere.
    for (const name of ['Tuition Fee', 'Transport fee', 'Exam fee', 'Fine']) {
      expect(slip).toContain(name);
    }
  });

  it('omits the rows that do not apply rather than printing ₹0', () => {
    const slip = buildFeeSlip([child()], 1_000);
    expect(slip).not.toContain('Concession');
    expect(slip).not.toContain('Previous dues');
    expect(slip).not.toContain('Less paid');
    expect(slip).not.toContain('₹ 0');
  });

  it('shows a concession, arrears and a part payment as adjustments', () => {
    const slip = buildFeeSlip(
      [
        child({
          lines: [{ name: 'Tuition Fee', amountRupees: 1_000 }],
          concessionRupees: 200,
          previousDuesRupees: 4_000,
          paidRupees: 500,
          totalRupees: 4_300,
        }),
      ],
      4_300,
    );

    expect(slip).toContain('Concession');
    expect(slip).toContain('Previous dues');
    expect(slip).toContain('Less paid');
    // The two deductions are signed, so the column can be read down and added up.
    expect(amountOf(rowsOf(slip).find((r) => r.startsWith('Concession')) as string)).toBe(-200);
    expect(amountOf(rowsOf(slip).find((r) => r.startsWith('Less paid')) as string)).toBe(-500);
  });

  it('reconciles: the rows above the total add up to it', () => {
    const slip = buildFeeSlip(
      [
        child({
          lines: [
            { name: 'Tuition Fee', amountRupees: 1_000 },
            { name: 'Transport fee', amountRupees: 700 },
          ],
          concessionRupees: 170,
          previousDuesRupees: 4_000,
          paidRupees: 500,
          totalRupees: 5_030,
        }),
      ],
      5_030,
    );

    const rows = rowsOf(slip);
    const total = rows.pop() as string;
    // This is the property a parent checks by eye. If it ever fails, the message is
    // asking for a number that its own rows do not explain.
    expect(rows.reduce((sum, row) => sum + amountOf(row), 0)).toBe(amountOf(total));
    expect(amountOf(total)).toBe(5_030);
  });
});

describe('buildFeeSlip — siblings', () => {
  const two = [
    child({ fullName: 'Aarav Sharma', classCode: '4', previousDuesRupees: 4_000, totalRupees: 5_000 }),
    child({
      fullName: 'Ananya Sharma',
      classCode: '1',
      lines: [{ name: 'Tuition Fee', amountRupees: 400 }],
      totalRupees: 400,
    }),
  ];

  it('gives each child a block and a subtotal, then one family total', () => {
    const slip = buildFeeSlip(two, 5_400);

    expect(slip.split('\n')).toEqual([
      '```',
      'Aarav Sharma · Std. 4',
      'Tuition Fee        ₹ 1,000',
      'Previous dues      ₹ 4,000',
      '  Subtotal         ₹ 5,000',
      '-'.repeat(TABLE_WIDTH),
      'Ananya Sharma · Std. 1',
      'Tuition Fee          ₹ 400',
      '  Subtotal           ₹ 400',
      '='.repeat(TABLE_WIDTH),
      'FAMILY TOTAL       ₹ 5,400',
      '```',
    ]);
  });

  it('drops the single-child header, which would be wrong for a family', () => {
    expect(buildFeeSlip(two, 5_400)).not.toContain('Name:');
  });

  it('adds the subtotals up to the family total', () => {
    const rows = rowsOf(buildFeeSlip(two, 5_400));
    const family = rows.pop() as string;
    const subtotals = rows.filter((row) => row.includes('Subtotal'));
    expect(subtotals.reduce((sum, row) => sum + amountOf(row), 0)).toBe(amountOf(family));
  });

  it('keeps one line per child in compact mode', () => {
    const slip = buildFeeSlip(two, 5_400, 'compact');

    expect(slip.split('\n')).toEqual([
      '```',
      'Aarav Sharma (4)   ₹ 5,000',
      'Ananya Sharma (1)    ₹ 400',
      '='.repeat(TABLE_WIDTH),
      'FAMILY TOTAL       ₹ 5,400',
      '```',
    ]);
  });
});

describe('buildFeeSlip — layout', () => {
  it('aligns every amount to the same column', () => {
    const slip = buildFeeSlip(
      [
        child({
          lines: [
            { name: 'Tuition Fee', amountRupees: 1_000 },
            { name: 'Transport fee', amountRupees: 7 },
            { name: 'Exam fee', amountRupees: 1_000_000 },
          ],
          totalRupees: 1_001_007,
        }),
      ],
      1_001_007,
    );

    for (const row of rowsOf(slip)) expect(row).toHaveLength(TABLE_WIDTH);
  });

  it('truncates a fee head name too long to sit beside its amount', () => {
    // feeHeadSchema allows 60 characters; left alone, the name would push the amount onto
    // its own wrapped line where it lines up with nothing.
    const slip = buildFeeSlip(
      [child({ lines: [{ name: 'Annual day and cultural programme contribution', amountRupees: 1_000 }], totalRupees: 1_000 })],
      1_000,
    );

    const row = rowsOf(slip)[0] as string;
    expect(row).toHaveLength(TABLE_WIDTH);
    expect(row).toContain('..');
    expect(row).toMatch(/₹ 1,000$/);
  });

  it('always closes the monospace fence', () => {
    for (const slip of [buildFeeSlip([child()], 1_000), buildFeeSlip([child(), child()], 2_000, 'compact')]) {
      expect(slip.split('\n').filter((line) => line === '```')).toHaveLength(2);
      expect(slip.startsWith('```')).toBe(true);
      expect(slip.endsWith('```')).toBe(true);
    }
  });
});

describe('fitWaMessage', () => {
  const phone = '919876543210';

  it('leaves a message that already fits alone', () => {
    const message = `hello\n${buildFeeSlip([child()], 1_000)}`;
    expect(fitWaMessage(phone, message)).toBe(message);
  });

  it('trims an oversized message and re-closes the fence', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      child({ fullName: `Child Number ${i}`, totalRupees: 1_000 }),
    );
    const message = buildFeeSlip(many, 200_000);
    expect(waUrlFits(phone, message)).toBe(false);

    const fitted = fitWaMessage(phone, message);
    expect(waUrlFits(phone, fitted)).toBe(true);
    // An unclosed ``` would render the rest of the parent's conversation as code.
    expect(fitted.split('\n').filter((line) => line === '```')).toHaveLength(2);
  });
});

describe('labels', () => {
  it('writes a class as a standard', () => {
    expect(stdLabel('4')).toBe('Std. 4');
    expect(stdLabel('NURSERY')).toBe('Nursery');
    expect(stdLabel('UKG')).toBe('UKG');
  });

  it('names the month of a period', () => {
    expect(periodLabel('2026-08')).toBe('August 2026');
    expect(periodLabel('2026-01')).toBe('January 2026');
    expect(periodLabel('2026-12')).toBe('December 2026');
  });

  it('ordinals the payment-window day', () => {
    expect([1, 2, 3, 4, 10, 11, 12, 13, 21, 22, 23].map(ordinalDay)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '10th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
    ]);
  });
});
