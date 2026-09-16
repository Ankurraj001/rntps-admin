import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { Expense } from '../../models/Expense.js';
import {
  allTimeTotals,
  anyExpenseRecorded,
  dayRows,
  dayTotals,
  monthTotals,
  splitByDirection,
} from './expenseLedger.js';

const MONTH = '2026-08';
const DAY = '2026-08-05';

async function add(name: string, amountRupees: number, direction?: 'EXPENSE' | 'INCOME', dateKey = DAY) {
  await Expense.create({
    dateKey,
    period: dateKey.slice(0, 7),
    name,
    amountRupees,
    recordedBy: 'tester',
    ...(direction ? { direction } : {}),
  });
}

/** A row as it exists in a database written before `direction` — no such field at all. */
async function addLegacy(name: string, amountRupees: number) {
  await mongoose.connection.collection('expenses').insertOne({
    dateKey: DAY,
    period: MONTH,
    name,
    amountRupees,
    recordedBy: 'someone',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeEach(async () => {
  await Expense.deleteMany({});
});

describe('splitByDirection', () => {
  it('separates the two sides without netting them off', () => {
    const totals = splitByDirection([
      { id: '1', dateKey: DAY, period: MONTH, name: 'Petrol', direction: 'EXPENSE', amountRupees: 800 },
      { id: '2', dateKey: DAY, period: MONTH, name: 'Grant', direction: 'INCOME', amountRupees: 5_000 },
      { id: '3', dateKey: DAY, period: MONTH, name: 'Bill', direction: 'EXPENSE', amountRupees: 200 },
    ]);

    expect(totals).toEqual({ expenseRupees: 1_000, gainRupees: 5_000 });
  });

  it('is zero on both sides for nothing at all', () => {
    expect(splitByDirection([])).toEqual({ expenseRupees: 0, gainRupees: 0 });
  });
});

describe('aggregated totals', () => {
  it('counts a row written before direction existed as spending', async () => {
    await addLegacy('Legacy petrol', 800);

    // Read as income it would swing the net by ₹1,600 in the wrong direction; dropped from
    // both sides it would silently shrink the month.
    await expect(monthTotals(MONTH)).resolves.toEqual({ expenseRupees: 800, gainRupees: 0 });
    await expect(allTimeTotals()).resolves.toEqual({ expenseRupees: 800, gainRupees: 0 });
  });

  it('splits a month by direction', async () => {
    await add('Petrol', 800, 'EXPENSE');
    await add('Grant', 5_000, 'INCOME');

    await expect(monthTotals(MONTH)).resolves.toEqual({ expenseRupees: 800, gainRupees: 5_000 });
  });

  it('keeps another month out', async () => {
    await add('August petrol', 800, 'EXPENSE');
    await add('September grant', 5_000, 'INCOME', '2026-09-05');

    await expect(monthTotals(MONTH)).resolves.toEqual({ expenseRupees: 800, gainRupees: 0 });
    await expect(allTimeTotals()).resolves.toEqual({ expenseRupees: 800, gainRupees: 5_000 });
  });

  it('narrows to a single day', async () => {
    await add('The 5th', 800, 'EXPENSE', '2026-08-05');
    await add('The 6th', 900, 'EXPENSE', '2026-08-06');

    await expect(dayTotals('2026-08-05')).resolves.toEqual({ expenseRupees: 800, gainRupees: 0 });
  });
});

describe('dayRows', () => {
  it('lists one day in one direction', async () => {
    await add('Grant', 5_000, 'INCOME');
    await add('Petrol', 800, 'EXPENSE');
    await add('Next day grant', 1_000, 'INCOME', '2026-08-06');

    const rows = await dayRows(DAY, 'INCOME');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Grant', direction: 'INCOME' });
  });

  it('treats a legacy row as spending here too', async () => {
    await addLegacy('Legacy petrol', 800);

    await expect(dayRows(DAY, 'INCOME')).resolves.toHaveLength(0);
    await expect(dayRows(DAY, 'EXPENSE')).resolves.toHaveLength(1);
  });
});

describe('anyExpenseRecorded', () => {
  it('is false for an empty ledger', async () => {
    await expect(anyExpenseRecorded()).resolves.toBe(false);
  });

  it('stays false when only income has been recorded', async () => {
    await add('Grant', 5_000, 'INCOME');

    // Gates the all-time net. A grant adds to the side that has no offsetting history, so
    // opening the gate on it would report a profit made of the school's whole fee income.
    await expect(anyExpenseRecorded()).resolves.toBe(false);
  });

  it('is true once spending exists, including a legacy row', async () => {
    await addLegacy('Legacy petrol', 800);
    await expect(anyExpenseRecorded()).resolves.toBe(true);
  });
});
