import { CLASS_CODES } from '@rntps/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { FeeStructure, feeStructureId } from '../models/FeeStructure.js';
import { seedSettings } from '../test/factories.js';
import { runBackfill } from './backfillTuitionFee.js';

const YEAR = '2026-27';

beforeEach(async () => {
  await seedSettings();
});

describe('backfillTuitionFee', () => {
  it('adds a ₹500 TUITION head to a structure missing one', async () => {
    await FeeStructure.create({
      _id: feeStructureId('5', YEAR),
      classCode: '5',
      academicYear: YEAR,
      heads: [{ code: 'TRANSPORT', name: 'Transport', amountRupees: 600, appliesTo: 'TRANSPORT_OPTED' }],
    });

    const result = await runBackfill({ academicYear: YEAR });

    const doc = await FeeStructure.findById(feeStructureId('5', YEAR)).lean();
    expect(doc?.heads).toHaveLength(2);
    expect(doc?.heads.find((h) => h.code === 'TUITION')).toEqual({
      code: 'TUITION',
      name: 'Tuition Fee',
      amountRupees: 500,
      appliesTo: 'ALL',
    });
    // The pre-existing head is untouched, not just present.
    expect(doc?.heads.find((h) => h.code === 'TRANSPORT')?.amountRupees).toBe(600);
    expect(result.addedToExisting).toBe(1);
  });

  it('leaves an existing TUITION head alone, including a ₹0 or custom amount', async () => {
    await FeeStructure.create({
      _id: feeStructureId('5', YEAR),
      classCode: '5',
      academicYear: YEAR,
      heads: [
        { code: 'TUITION', name: 'Tuition Fee', amountRupees: 0, appliesTo: 'ALL' },
        { code: 'TRANSPORT', name: 'Transport', amountRupees: 600, appliesTo: 'TRANSPORT_OPTED' },
      ],
    });

    const result = await runBackfill({ academicYear: YEAR });

    const doc = await FeeStructure.findById(feeStructureId('5', YEAR)).lean();
    // Guards against the array-negation query mistake: `{'heads.code': {$ne: 'TUITION'}}`
    // would still match this document (TRANSPORT != TUITION) and wrongly push a second
    // TUITION head onto it.
    expect(doc?.heads).toHaveLength(2);
    expect(doc?.heads.find((h) => h.code === 'TUITION')?.amountRupees).toBe(0);
    expect(result.addedToExisting).toBe(0);
  });

  it('creates a Tuition-only structure for a class with none in the active year', async () => {
    const result = await runBackfill({ academicYear: YEAR });

    expect(result.createdNew).toEqual([...CLASS_CODES]);
    for (const classCode of CLASS_CODES) {
      const doc = await FeeStructure.findById(feeStructureId(classCode, YEAR)).lean();
      expect(doc?.heads).toEqual([{ code: 'TUITION', name: 'Tuition Fee', amountRupees: 500, appliesTo: 'ALL' }]);
    }
  });

  it('does not create a duplicate structure for a class+year that already has one', async () => {
    await FeeStructure.create({
      _id: feeStructureId('5', YEAR),
      classCode: '5',
      academicYear: YEAR,
      heads: [{ code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_200, appliesTo: 'ALL' }],
    });

    const result = await runBackfill({ academicYear: YEAR });

    expect(result.createdNew).not.toContain('5');
    const doc = await FeeStructure.findById(feeStructureId('5', YEAR)).lean();
    expect(doc?.heads).toHaveLength(1);
    expect(doc?.heads[0]?.amountRupees).toBe(1_200);
  });

  it('is idempotent — a second run reports nothing left to do', async () => {
    await FeeStructure.create({
      _id: feeStructureId('5', YEAR),
      classCode: '5',
      academicYear: YEAR,
      heads: [{ code: 'TRANSPORT', name: 'Transport', amountRupees: 600, appliesTo: 'TRANSPORT_OPTED' }],
    });

    await runBackfill({ academicYear: YEAR });
    const second = await runBackfill({ academicYear: YEAR });

    expect(second.addedToExisting).toBe(0);
    expect(second.createdNew).toEqual([]);
  });

  it('--dry-run reports counts but writes nothing', async () => {
    await FeeStructure.create({
      _id: feeStructureId('5', YEAR),
      classCode: '5',
      academicYear: YEAR,
      heads: [{ code: 'TRANSPORT', name: 'Transport', amountRupees: 600, appliesTo: 'TRANSPORT_OPTED' }],
    });

    const result = await runBackfill({ academicYear: YEAR, dryRun: true });

    expect(result.addedToExisting).toBe(1);
    expect(result.createdNew.length).toBe(CLASS_CODES.length - 1);

    const doc = await FeeStructure.findById(feeStructureId('5', YEAR)).lean();
    expect(doc?.heads).toHaveLength(1); // unchanged
    for (const classCode of CLASS_CODES) {
      if (classCode === '5') continue;
      expect(await FeeStructure.findById(feeStructureId(classCode, YEAR)).lean()).toBeNull();
    }
  });
});
