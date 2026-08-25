import { buildLineItems, formatINR } from '@rntps/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { adminAuth, seedSettings, studentInput } from '../../test/factories.js';
import { createStudent } from '../students/student.service.js';

const YEAR = '2026-27';
const PERIOD = '2026-08';

const TUITION = { code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_200, appliesTo: 'ALL' as const };
const TRANSPORT = {
  code: 'TRANSPORT',
  name: 'Transport',
  amountRupees: 600,
  appliesTo: 'TRANSPORT_OPTED' as const,
};

describe('buildLineItems', () => {
  it('treats a missing override as no override, not as an override of nothing', () => {
    // A student document written before the transport field existed reads back with the
    // field undefined. `undefined !== null` is true, so an unguarded check would take the
    // override branch and bill an amount of undefined — a NaN invoice total.
    const legacy = { transportOpted: true } as unknown as Parameters<typeof buildLineItems>[1];
    const { lineItems, transportOverridden } = buildLineItems([TUITION, TRANSPORT], legacy);

    expect(lineItems.map((i) => i.amountRupees)).toEqual([1_200, 600]);
    expect(lineItems.every((i) => Number.isInteger(i.amountRupees))).toBe(true);
    expect(transportOverridden).toBe(false);
  });

  it('uses the class default when no override is set', () => {
    const { lineItems, transportOverridden } = buildLineItems([TUITION, TRANSPORT], {
      transportOpted: true,
      transportFareOverrideRupees: null,
    });

    expect(lineItems.map((i) => i.amountRupees)).toEqual([1_200, 600]);
    expect(transportOverridden).toBe(false);
  });

  it('replaces the transport amount but keeps its name', () => {
    const { lineItems, transportOverridden } = buildLineItems([TUITION, TRANSPORT], {
      transportOpted: true,
      transportFareOverrideRupees: 950,
    });

    expect(lineItems).toEqual([
      { code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_200 },
      // Still reads "Transport" on the invoice, just at this student's fare.
      { code: 'TRANSPORT', name: 'Transport', amountRupees: 950 },
    ]);
    expect(transportOverridden).toBe(true);
  });

  it('bills nothing for transport when the student does not use it, override or not', () => {
    const { lineItems } = buildLineItems([TUITION, TRANSPORT], {
      transportOpted: false,
      transportFareOverrideRupees: 950,
    });

    expect(lineItems).toEqual([{ code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_200 }]);
  });

  it('accepts a zero fare, for a child who travels free', () => {
    const { lineItems, transportOverridden } = buildLineItems([TUITION, TRANSPORT], {
      transportOpted: true,
      transportFareOverrideRupees: 0,
    });

    expect(lineItems[1]?.amountRupees).toBe(0);
    // Zero is a deliberate fare, not "unset" — null is what means unset.
    expect(transportOverridden).toBe(true);
  });

  it("bills the student's own fare even when the class has no transport head", () => {
    // A transport head in the fee structure is a default, not a prerequisite. The
    // student's record is the authority on whether they use the bus.
    const { lineItems, transportOverridden, transportUnpriced } = buildLineItems([TUITION], {
      transportOpted: true,
      transportFareOverrideRupees: 950,
    });

    expect(lineItems).toEqual([
      { code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_200 },
      { code: 'TRANSPORT', name: 'Transport fee', amountRupees: 950 },
    ]);
    expect(transportOverridden).toBe(true);
    expect(transportUnpriced).toBe(false);
  });

  it('reports transport as unpriced when neither the student nor the class names an amount', () => {
    const { lineItems, transportUnpriced } = buildLineItems([TUITION], {
      transportOpted: true,
      transportFareOverrideRupees: null,
    });

    // The one case that genuinely cannot be billed — there is no amount anywhere.
    expect(lineItems).toHaveLength(1);
    expect(transportUnpriced).toBe(true);
  });

  it('does not synthesise a transport line over a class head already using that code', () => {
    // A class charging everyone under TRANSPORT is describing something else; adding a
    // second line with the same code would bill the student twice.
    const clash = { code: 'TRANSPORT', name: 'Transport levy', amountRupees: 200, appliesTo: 'ALL' as const };
    const { lineItems } = buildLineItems([TUITION, clash], {
      transportOpted: true,
      transportFareOverrideRupees: 950,
    });

    expect(lineItems).toHaveLength(2);
    expect(lineItems.filter((i) => i.code === 'TRANSPORT')).toHaveLength(1);
  });

  it('leaves transport unbilled when the student opted out, class head or not', () => {
    const { lineItems, transportUnpriced } = buildLineItems([TUITION], {
      transportOpted: false,
      transportFareOverrideRupees: 950,
    });

    expect(lineItems).toHaveLength(1);
    expect(transportUnpriced).toBe(false);
  });

  it('collapses several transport heads into one overridden line', () => {
    const extra = { code: 'BUS_MAINT', name: 'Bus upkeep', amountRupees: 100, appliesTo: 'TRANSPORT_OPTED' as const };
    const { lineItems } = buildLineItems([TUITION, TRANSPORT, extra], {
      transportOpted: true,
      transportFareOverrideRupees: 950,
    });

    // One override cannot be split across two heads, so it becomes a single line.
    expect(lineItems).toHaveLength(2);
    expect(lineItems[1]).toMatchObject({ code: 'TRANSPORT', amountRupees: 950 });
  });
});

describe('per-student transport fares through the invoice run', () => {
  let app: Express;
  let adminHeader: string;

  const as = {
    get: (p: string) => request(app).get(p).set('Authorization', adminHeader),
    post: (p: string) => request(app).post(p).set('Authorization', adminHeader),
    put: (p: string) => request(app).put(p).set('Authorization', adminHeader),
    patch: (p: string) => request(app).patch(p).set('Authorization', adminHeader),
  };

  beforeEach(async () => {
    await seedSettings();
    app = createApp();
    adminHeader = (await adminAuth()).header;
    await as.put(`/api/v1/fees/structures/5/${YEAR}`).send({ heads: [TUITION, TRANSPORT] }).expect(200);
  });

  it('bills three students on the same bus at three different fares', async () => {
    await createStudent(
      studentInput({ fullName: 'Near Stop', classCode: '5', transportOpted: true, transportFareOverrideRupees: 400 }),
    );
    await createStudent(
      studentInput({ fullName: 'Far Stop', classCode: '5', transportOpted: true, transportFareOverrideRupees: 950 }),
    );
    // No override: falls back to the class default of ₹600.
    await createStudent(studentInput({ fullName: 'Default Stop', classCode: '5', transportOpted: true }));

    const res = await as.post('/api/v1/fees/runs/preview').send({ period: PERIOD }).expect(200);
    const byName = Object.fromEntries(
      (res.body.rows as { fullName: string; totalRupees: number; transportOverridden: boolean }[]).map((r) => [
        r.fullName,
        r,
      ]),
    );

    expect(byName['Near Stop']).toMatchObject({ totalRupees: 1_600, transportOverridden: true });
    expect(byName['Far Stop']).toMatchObject({ totalRupees: 2_150, transportOverridden: true });
    expect(byName['Default Stop']).toMatchObject({ totalRupees: 1_800, transportOverridden: false });
  });

  it('carries the overridden fare onto the committed invoice', async () => {
    const student = await createStudent(
      studentInput({ fullName: 'Far Stop', classCode: '5', transportOpted: true, transportFareOverrideRupees: 950 }),
    );

    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);
    const invoice = await as.get(`/api/v1/fees/invoices/${student.studentId}:${PERIOD}`).expect(200);

    expect(invoice.body.lineItems).toEqual([
      { code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_200 },
      { code: 'TRANSPORT', name: 'Transport', amountRupees: 950 },
    ]);
    expect(invoice.body.totalRupees).toBe(2_150);
  });

  it('applies a concession to the overridden total', async () => {
    await createStudent(
      studentInput({
        fullName: 'Far Stop',
        classCode: '5',
        transportOpted: true,
        transportFareOverrideRupees: 800,
        concession: { type: 'PERCENT', value: 50, reason: 'Staff child' },
      }),
    );

    const res = await as.post('/api/v1/fees/runs/preview').send({ period: PERIOD }).expect(200);
    // Gross ₹1,200 + ₹800 = ₹2,000; 50% off = ₹1,000. The concession covers transport too.
    expect(res.body.rows[0]).toMatchObject({ grossRupees: 2_000, concessionRupees: 1_000, totalRupees: 1_000 });
  });

  it('flags a fare that will not be billed rather than dropping it silently', async () => {
    // Transport fare set, but the student is not marked as using transport.
    await createStudent(
      studentInput({ fullName: 'Fare But No Bus', classCode: '5', transportOpted: false, transportFareOverrideRupees: 500 }),
    );

    const res = await as.post('/api/v1/fees/runs/preview').send({ period: PERIOD }).expect(200);
    expect(res.body.rows[0]).toMatchObject({ transportFareIgnored: true, totalRupees: 1_200 });
  });

  it('changing one student’s fare leaves everyone else alone', async () => {
    const a = await createStudent(
      studentInput({ fullName: 'Student A', classCode: '5', transportOpted: true }),
    );
    await createStudent(studentInput({ fullName: 'Student B', classCode: '5', transportOpted: true }));

    await as.patch(`/api/v1/students/${a.studentId}`).send({ transportFareOverrideRupees: 300 }).expect(200);

    const res = await as.post('/api/v1/fees/runs/preview').send({ period: PERIOD }).expect(200);
    const totals = Object.fromEntries(
      (res.body.rows as { fullName: string; totalRupees: number }[]).map((r) => [r.fullName, r.totalRupees]),
    );

    expect(totals['Student A']).toBe(1_500);
    expect(totals['Student B']).toBe(1_800);
  });

  it('clearing the override restores the class default', async () => {
    const student = await createStudent(
      studentInput({ fullName: 'Reverted', classCode: '5', transportOpted: true, transportFareOverrideRupees: 950 }),
    );

    const cleared = await as
      .patch(`/api/v1/students/${student.studentId}`)
      .send({ transportFareOverrideRupees: null })
      .expect(200);
    expect(cleared.body.transportFareOverrideRupees).toBeNull();

    const res = await as.post('/api/v1/fees/runs/preview').send({ period: PERIOD }).expect(200);
    expect(res.body.rows[0]).toMatchObject({ totalRupees: 1_800, transportOverridden: false });
  });

  it('a class fee change still moves everyone who has no override', async () => {
    await createStudent(studentInput({ fullName: 'On Default', classCode: '5', transportOpted: true }));
    await createStudent(
      studentInput({ fullName: 'On Override', classCode: '5', transportOpted: true, transportFareOverrideRupees: 950 }),
    );

    // Raise the class transport fare.
    await as
      .put(`/api/v1/fees/structures/5/${YEAR}`)
      .send({ heads: [TUITION, { ...TRANSPORT, amountRupees: 700 }] })
      .expect(200);

    const res = await as.post('/api/v1/fees/runs/preview').send({ period: PERIOD }).expect(200);
    const totals = Object.fromEntries(
      (res.body.rows as { fullName: string; totalRupees: number }[]).map((r) => [r.fullName, r.totalRupees]),
    );

    expect(totals['On Default']).toBe(1_900);
    // The override is unaffected by the class change, which is the point of it.
    expect(totals['On Override']).toBe(2_150);
  });

  it('rejects a negative or fractional fare', async () => {
    const student = await createStudent(studentInput({ fullName: 'Bad Fare', classCode: '5', transportOpted: true }));

    await as.patch(`/api/v1/students/${student.studentId}`).send({ transportFareOverrideRupees: -1 }).expect(400);
    await as.patch(`/api/v1/students/${student.studentId}`).send({ transportFareOverrideRupees: 100.5 }).expect(400);
  });

  it('formats an overridden fare the same as any other amount', () => {
    expect(formatINR(950)).toBe('₹950');
  });
});

describe('transport without a class transport head', () => {
  let app: Express;
  let adminHeader: string;

  const as = {
    get: (p: string) => request(app).get(p).set('Authorization', adminHeader),
    post: (p: string) => request(app).post(p).set('Authorization', adminHeader),
    put: (p: string) => request(app).put(p).set('Authorization', adminHeader),
  };

  // Class 1 charges tuition only — no transport head at all.
  const TUITION_ONLY = [{ code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_200, appliesTo: 'ALL' }];

  beforeEach(async () => {
    await seedSettings();
    app = createApp();
    adminHeader = (await adminAuth()).header;
    await as.put(`/api/v1/fees/structures/1/${YEAR}`).send({ heads: TUITION_ONLY }).expect(200);
  });

  it('bills the fare through the invoice run and onto the invoice', async () => {
    const student = await createStudent(
      studentInput({
        fullName: 'Bus No Head',
        classCode: '1',
        transportOpted: true,
        transportFareOverrideRupees: 600,
      }),
    );

    const preview = await as.post('/api/v1/fees/runs/preview').send({ period: PERIOD }).expect(200);
    const row = (preview.body.rows as { studentId: string }[]).find((r) => r.studentId === student.studentId);
    expect(row).toMatchObject({
      totalRupees: 1_800,
      transportOverridden: true,
      transportUnpriced: false,
      transportFareIgnored: false,
    });

    await as.post('/api/v1/fees/runs/commit').send({ period: PERIOD }).expect(200);
    const invoice = await as.get(`/api/v1/fees/invoices/${student.studentId}:${PERIOD}`).expect(200);
    expect(invoice.body.lineItems).toEqual([
      { code: 'TUITION', name: 'Tuition Fee', amountRupees: 1_200 },
      { code: 'TRANSPORT', name: 'Transport fee', amountRupees: 600 },
    ]);
    expect(invoice.body.totalRupees).toBe(1_800);
  });

  it('flags a transport student with no fare anywhere', async () => {
    const student = await createStudent(
      studentInput({ fullName: 'Bus No Price', classCode: '1', transportOpted: true }),
    );

    const preview = await as.post('/api/v1/fees/runs/preview').send({ period: PERIOD }).expect(200);
    const row = (preview.body.rows as { studentId: string }[]).find((r) => r.studentId === student.studentId);
    expect(row).toMatchObject({ totalRupees: 1_200, transportUnpriced: true });
  });

  it('still applies the concession to a fare billed this way', async () => {
    const student = await createStudent(
      studentInput({
        fullName: 'Concession No Head',
        classCode: '1',
        transportOpted: true,
        transportFareOverrideRupees: 800,
        concession: { type: 'PERCENT', value: 50, reason: 'Staff child' },
      }),
    );

    const preview = await as.post('/api/v1/fees/runs/preview').send({ period: PERIOD }).expect(200);
    const row = (preview.body.rows as { studentId: string }[]).find((r) => r.studentId === student.studentId);
    // 1200 + 800 = 2000 gross, 50% off = 1000.
    expect(row).toMatchObject({ grossRupees: 2_000, concessionRupees: 1_000, totalRupees: 1_000 });
  });
});
