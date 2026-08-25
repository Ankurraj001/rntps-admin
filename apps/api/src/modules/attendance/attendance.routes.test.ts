import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { Attendance } from '../../models/Attendance.js';
import { SETTINGS_ID, Settings } from '../../models/Settings.js';
import { adminAuth, createTestUser, seedSettings, studentInput, teacherAuth, tokenFor } from '../../test/factories.js';
import { createStudent } from '../students/student.service.js';

let app: Express;
let adminHeader: string;

const TODAY = '2026-08-24';

async function seedClass(classCode: string, names: string[]) {
  const ids: string[] = [];
  for (const [index, fullName] of names.entries()) {
    const student = await createStudent(
      studentInput({ fullName, classCode: classCode as never, rollNo: index + 1 }),
    );
    ids.push(student.studentId);
  }
  return ids;
}

beforeEach(async () => {
  await seedSettings();
  app = createApp();
  adminHeader = (await adminAuth()).header;
});

describe('PUT /attendance/roster', () => {
  it('saves a roster and reads it back', async () => {
    const [a, b] = await seedClass('5', ['Aarav Sharma', 'Diya Verma']);

    await request(app)
      .put('/api/v1/attendance/roster')
      .set('Authorization', adminHeader)
      .send({
        classCode: '5',
        dateKey: TODAY,
        marks: [
          { studentId: a, status: 'PRESENT' },
          { studentId: b, status: 'ABSENT', remarks: 'Fever' },
        ],
      })
      .expect(200);

    const roster = await request(app)
      .get('/api/v1/attendance/roster')
      .query({ classCode: '5', dateKey: TODAY })
      .set('Authorization', adminHeader)
      .expect(200);

    expect(roster.body.entries).toHaveLength(2);
    expect(roster.body.entries[0]).toMatchObject({ studentId: a, status: 'PRESENT', rollNo: 1 });
    expect(roster.body.entries[1]).toMatchObject({ studentId: b, status: 'ABSENT', remarks: 'Fever' });
    expect(roster.body.submittedBy).toEqual(expect.any(String));
  });

  it('is idempotent — resubmitting corrects rather than duplicating', async () => {
    const [a] = await seedClass('5', ['Aarav Sharma']);

    const send = (status: string) =>
      request(app)
        .put('/api/v1/attendance/roster')
        .set('Authorization', adminHeader)
        .send({ classCode: '5', dateKey: TODAY, marks: [{ studentId: a, status }] })
        .expect(200);

    await send('ABSENT');
    await send('PRESENT');

    expect(await Attendance.countDocuments()).toBe(1);
    const record = await Attendance.findById(`${a}:${TODAY}`).lean();
    expect(record?.status).toBe('PRESENT');
  });

  it('uses the studentId:dateKey pair as the primary key', async () => {
    const [a] = await seedClass('5', ['Aarav Sharma']);
    await request(app)
      .put('/api/v1/attendance/roster')
      .set('Authorization', adminHeader)
      .send({ classCode: '5', dateKey: TODAY, marks: [{ studentId: a, status: 'PRESENT' }] })
      .expect(200);

    expect(await Attendance.findById(`${a}:${TODAY}`)).not.toBeNull();
  });

  it('refuses a future date', async () => {
    const [a] = await seedClass('5', ['Aarav Sharma']);
    const res = await request(app)
      .put('/api/v1/attendance/roster')
      .set('Authorization', adminHeader)
      .send({ classCode: '5', dateKey: '2099-01-01', marks: [{ studentId: a, status: 'PRESENT' }] })
      .expect(400);

    expect(res.body.error.message).toMatch(/future/i);
  });

  it('refuses a student who is not on that class roll', async () => {
    await seedClass('5', ['Aarav Sharma']);
    const [outsider] = await seedClass('6', ['Kabir Singh']);

    const res = await request(app)
      .put('/api/v1/attendance/roster')
      .set('Authorization', adminHeader)
      .send({ classCode: '5', dateKey: TODAY, marks: [{ studentId: outsider, status: 'ABSENT' }] })
      .expect(400);

    expect(res.body.error.message).toMatch(/not on the 5 roll/i);
  });

  it('rejects an unknown status', async () => {
    const [a] = await seedClass('5', ['Aarav Sharma']);
    await request(app)
      .put('/api/v1/attendance/roster')
      .set('Authorization', adminHeader)
      .send({ classCode: '5', dateKey: TODAY, marks: [{ studentId: a, status: 'MAYBE' }] })
      .expect(400);
  });

  it('excludes inactive students from the roster', async () => {
    const [a, b] = await seedClass('5', ['Aarav Sharma', 'Diya Verma']);
    await request(app)
      .post(`/api/v1/students/${b}/status`)
      .set('Authorization', adminHeader)
      .send({ status: 'TC_ISSUED' })
      .expect(200);

    const roster = await request(app)
      .get('/api/v1/attendance/roster')
      .query({ classCode: '5', dateKey: TODAY })
      .set('Authorization', adminHeader)
      .expect(200);

    expect(roster.body.entries.map((e: { studentId: string }) => e.studentId)).toEqual([a]);
  });

  it('flags a holiday without blocking marking', async () => {
    await seedClass('5', ['Aarav Sharma']);
    await Settings.updateOne(
      { _id: SETTINGS_ID },
      { $set: { holidays: [{ dateKey: TODAY, label: 'Independence Day' }] } },
    );

    const roster = await request(app)
      .get('/api/v1/attendance/roster')
      .query({ classCode: '5', dateKey: TODAY })
      .set('Authorization', adminHeader)
      .expect(200);

    expect(roster.body.holiday).toMatchObject({ label: 'Independence Day' });
  });
});

describe('teacher class access', () => {
  it('lets a teacher mark only their assigned classes', async () => {
    const [a] = await seedClass('5', ['Aarav Sharma']);
    const [b] = await seedClass('6', ['Kabir Singh']);
    const { header } = await teacherAuth(['5']);

    await request(app)
      .put('/api/v1/attendance/roster')
      .set('Authorization', header)
      .send({ classCode: '5', dateKey: TODAY, marks: [{ studentId: a, status: 'PRESENT' }] })
      .expect(200);

    const denied = await request(app)
      .put('/api/v1/attendance/roster')
      .set('Authorization', header)
      .send({ classCode: '6', dateKey: TODAY, marks: [{ studentId: b, status: 'PRESENT' }] })
      .expect(403);

    expect(denied.body.error.message).toMatch(/not assigned to 6/i);
  });

  it('blocks reading another class roster and monthly grid', async () => {
    await seedClass('6', ['Kabir Singh']);
    const { header } = await teacherAuth(['5']);

    await request(app)
      .get('/api/v1/attendance/roster')
      .query({ classCode: '6', dateKey: TODAY })
      .set('Authorization', header)
      .expect(403);

    await request(app)
      .get('/api/v1/attendance/monthly')
      .query({ classCode: '6', month: '2026-08' })
      .set('Authorization', header)
      .expect(403);
  });

  it('keeps the school-wide defaulter report admin-only', async () => {
    const { header } = await teacherAuth(['5']);
    await request(app)
      .get('/api/v1/attendance/defaulters')
      .query({ month: '2026-08' })
      .set('Authorization', header)
      .expect(403);
  });

  it('only nudges a teacher about their own unmarked classes', async () => {
    await seedClass('5', ['Aarav Sharma']);
    await seedClass('6', ['Kabir Singh']);
    const { header } = await teacherAuth(['5']);

    const res = await request(app).get('/api/v1/attendance/unmarked').set('Authorization', header).expect(200);
    expect(res.body.classes).toEqual(['5']);
  });

  it('requires a signed-in user', async () => {
    await request(app).get('/api/v1/attendance/roster').query({ classCode: '5', dateKey: TODAY }).expect(401);
  });
});

describe('monthly grid and percentages', () => {
  it('computes the percentage over working days, excluding holidays', async () => {
    const [a] = await seedClass('5', ['Aarav Sharma']);
    const marks: [string, string][] = [
      ['2026-08-03', 'PRESENT'],
      ['2026-08-04', 'PRESENT'],
      ['2026-08-05', 'PRESENT'],
      ['2026-08-06', 'ABSENT'],
      ['2026-08-07', 'HOLIDAY'],
    ];

    for (const [dateKey, status] of marks) {
      await request(app)
        .put('/api/v1/attendance/roster')
        .set('Authorization', adminHeader)
        .send({ classCode: '5', dateKey, marks: [{ studentId: a, status }] })
        .expect(200);
    }

    const res = await request(app)
      .get('/api/v1/attendance/monthly')
      .query({ classCode: '5', month: '2026-08' })
      .set('Authorization', adminHeader)
      .expect(200);

    const row = res.body.rows[0];
    // 3 present of 4 working days. The declared holiday is not a working day, and neither
    // are August 2026's five Sundays — so `holiday` is 1 + 5.
    expect(row.totals).toMatchObject({ present: 3, absent: 1, holiday: 6, workingDays: 4 });
    expect(row.totals.percentage).toBe(75);
  });

  it('returns every day of the month, so the grid has fixed columns', async () => {
    await seedClass('5', ['Aarav Sharma']);
    const res = await request(app)
      .get('/api/v1/attendance/monthly')
      .query({ classCode: '5', month: '2026-02' })
      .set('Authorization', adminHeader)
      .expect(200);

    // 2028 is a leap year; 2026 is not.
    expect(res.body.dateKeys).toHaveLength(28);
    expect(res.body.dateKeys[0]).toBe('2026-02-01');
  });

  it('handles a 31-day month', async () => {
    await seedClass('5', ['Aarav Sharma']);
    const res = await request(app)
      .get('/api/v1/attendance/monthly')
      .query({ classCode: '5', month: '2026-01' })
      .set('Authorization', adminHeader)
      .expect(200);
    expect(res.body.dateKeys).toHaveLength(31);
  });

  it('rejects a malformed month', async () => {
    await request(app)
      .get('/api/v1/attendance/monthly')
      .query({ classCode: '5', month: '2026-13' })
      .set('Authorization', adminHeader)
      .expect(400);
  });
});

describe('defaulters report', () => {
  it('lists students below the threshold, worst first', async () => {
    const [a, b] = await seedClass('5', ['Aarav Sharma', 'Diya Verma']);

    // a: 1 of 4 present (25%). b: 4 of 4 (100%).
    const days = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06'];
    for (const [index, dateKey] of days.entries()) {
      await request(app)
        .put('/api/v1/attendance/roster')
        .set('Authorization', adminHeader)
        .send({
          classCode: '5',
          dateKey,
          marks: [
            { studentId: a, status: index === 0 ? 'PRESENT' : 'ABSENT' },
            { studentId: b, status: 'PRESENT' },
          ],
        })
        .expect(200);
    }

    const res = await request(app)
      .get('/api/v1/attendance/defaulters')
      .query({ month: '2026-08', threshold: 75 })
      .set('Authorization', adminHeader)
      .expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ studentId: a });
    expect(res.body.items[0].totals.percentage).toBe(25);
  });

  it('ignores students with nothing marked, rather than reporting them as 0%', async () => {
    await seedClass('5', ['Aarav Sharma']);

    const res = await request(app)
      .get('/api/v1/attendance/defaulters')
      .query({ month: '2026-08', threshold: 75 })
      .set('Authorization', adminHeader)
      .expect(200);

    expect(res.body.items).toEqual([]);
  });
});

describe('student attendance history', () => {
  it('returns records newest first with totals', async () => {
    const [a] = await seedClass('5', ['Aarav Sharma']);
    for (const [dateKey, status] of [['2026-08-03', 'PRESENT'], ['2026-08-04', 'ABSENT']] as [string, string][]) {
      await request(app)
        .put('/api/v1/attendance/roster')
        .set('Authorization', adminHeader)
        .send({ classCode: '5', dateKey, marks: [{ studentId: a, status }] })
        .expect(200);
    }

    const res = await request(app)
      .get(`/api/v1/attendance/student/${a}`)
      .set('Authorization', adminHeader)
      .expect(200);

    expect(res.body.records[0].dateKey).toBe('2026-08-04');
    expect(res.body.totals).toMatchObject({ present: 1, absent: 1, workingDays: 2, percentage: 50 });
  });
});

describe('audit trail', () => {
  it('records who saved a roster', async () => {
    const teacher = await createTestUser({ role: 'TEACHER', email: 'tt@school.test', assignedClasses: ['5'] });
    const [a] = await seedClass('5', ['Aarav Sharma']);

    await request(app)
      .put('/api/v1/attendance/roster')
      .set('Authorization', `Bearer ${await tokenFor(teacher)}`)
      .send({ classCode: '5', dateKey: TODAY, marks: [{ studentId: a, status: 'PRESENT' }] })
      .expect(200);

    const record = await Attendance.findById(`${a}:${TODAY}`).lean();
    expect(record?.markedBy).toBe(String(teacher._id));
  });
});
