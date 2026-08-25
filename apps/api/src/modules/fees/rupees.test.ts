import { concessionFor, describeConcession, formatINR } from '@rntps/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { adminAuth, seedSettings, studentInput } from '../../test/factories.js';

/**
 * Money is integer rupees. These tests pin the two things that carry the correctness
 * burden of that choice: fractional amounts are refused at every entry point rather than
 * silently truncated, and a percentage concession rounds predictably.
 */

let app: Express;
let adminHeader: string;

const YEAR = '2026-27';
const PERIOD = '2026-08';

const as = {
  post: (p: string) => request(app).post(p).set('Authorization', adminHeader),
  put: (p: string) => request(app).put(p).set('Authorization', adminHeader),
};

const TUITION = { code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_200, appliesTo: 'ALL' };

beforeEach(async () => {
  await seedSettings();
  app = createApp();
  adminHeader = (await adminAuth()).header;
});

describe('formatINR', () => {
  it('renders whole rupees with no decimal places', () => {
    expect(formatINR(1_200)).toBe('₹1,200');
    expect(formatINR(0)).toBe('₹0');
  });

  it('groups in the Indian system, not thousands', () => {
    // ₹1,80,050 — lakhs, not 180,050. A year's fees for a class reaches this range.
    expect(formatINR(180_050)).toBe('₹1,80,050');
  });
});

describe('concessionFor', () => {
  it('rounds a percentage to the nearest rupee', () => {
    // 10% of ₹1,255 is ₹125.50, which cannot be represented — it rounds the student's way.
    expect(concessionFor(1_255, { type: 'PERCENT', value: 10 })).toBe(126);
    expect(concessionFor(1_200, { type: 'PERCENT', value: 33 })).toBe(396);
  });

  it('never exceeds the amount owed', () => {
    expect(concessionFor(1_200, { type: 'FLAT', value: 5_000 })).toBe(1_200);
    expect(concessionFor(1_200, { type: 'PERCENT', value: 100 })).toBe(1_200);
  });

  it('returns a whole number of rupees for a fractional percentage', () => {
    const result = concessionFor(1_000, { type: 'PERCENT', value: 12.5 });
    expect(result).toBe(125);
    expect(Number.isInteger(result)).toBe(true);
  });

  it('describes a flat concession in rupees', () => {
    expect(describeConcession({ type: 'FLAT', value: 750 })).toBe('flat ₹750');
    expect(describeConcession({ type: 'PERCENT', value: 25 })).toBe('25%');
  });
});

describe('fractional amounts are refused at the API edge', () => {
  it('rejects a fractional fee head amount', async () => {
    await as
      .put(`/api/v1/fees/structures/5/${YEAR}`)
      .send({ heads: [{ ...TUITION, amountRupees: 1_200.5 }] })
      .expect(400);
  });

  it('rejects a fractional flat concession', async () => {
    const res = await as
      .post('/api/v1/students')
      .send({
        ...studentInput({ fullName: 'Fractional Waiver', classCode: '5' }),
        concession: { type: 'FLAT', value: 250.5, reason: 'Half a rupee off' },
      })
      .expect(400);

    expect(JSON.stringify(res.body)).toContain('whole number of rupees');
  });

  it('accepts a fractional percentage, which is a real thing a school offers', async () => {
    const res = await as
      .post('/api/v1/students')
      .send({
        ...studentInput({ fullName: 'Half Percent', classCode: '5' }),
        concession: { type: 'PERCENT', value: 12.5, reason: 'Staff child' },
      })
      .expect(201);

    expect(res.body.concession.value).toBe(12.5);
  });

  it('rejects a fractional payment amount', async () => {
    await as.put(`/api/v1/fees/structures/5/${YEAR}`).send({ heads: [TUITION] }).expect(200);
    const student = await as.post('/api/v1/students').send(studentInput({ classCode: '5' })).expect(201);
    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);

    await as
      .post(`/api/v1/fees/invoices/${student.body.studentId}:${PERIOD}/payments`)
      .send({ amountRupees: 500.5, mode: 'CASH', paidAt: '2026-08-05' })
      .expect(400);
  });
});
