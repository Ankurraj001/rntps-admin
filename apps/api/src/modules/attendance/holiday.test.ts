import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { Attendance } from '../../models/Attendance.js';
import { adminAuth, createTestUser, seedSettings, studentInput, teacherAuth } from '../../test/factories.js';
import { createStudent } from '../students/student.service.js';
import { getUnmarkedClasses } from './attendance.service.js';

/**
 * A declared school holiday closes the whole school, in one write.
 *
 * It is stored on the settings document rather than as an attendance record per child,
 * which is what makes it school-wide by construction: there is no per-class copy to get
 * out of step, a child enrolled afterwards sees the same closed day, and undoing it is
 * one $pull rather than a delete per student. The rules below are deliberately the same
 * ones Sunday already follows — see sunday.test.ts.
 */

let app: Express;
let adminHeader: string;
let studentId: string;

// August 2026 — the 24th is a Monday, the 2nd a Sunday.
const MONDAY = '2026-08-24';
const TUESDAY = '2026-08-25';
const SUNDAY = '2026-08-02';

const as = {
  get: (p: string) => request(app).get(p).set('Authorization', adminHeader),
  put: (p: string) => request(app).put(p).set('Authorization', adminHeader),
  post: (p: string) => request(app).post(p).set('Authorization', adminHeader),
  delete: (p: string) => request(app).delete(p).set('Authorization', adminHeader),
};

const declare = (dateKey: string, label: string) =>
  as.post('/api/v1/attendance/holiday').send({ dateKey, label });

beforeEach(async () => {
  await seedSettings();
  app = createApp();
  adminHeader = (await adminAuth()).header;
  const student = await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));
  studentId = student.studentId;
});

describe('declaring a holiday', () => {
  it('closes every class from one call, without writing a record per student', async () => {
    await createStudent(studentInput({ fullName: 'Kabir Singh', classCode: '7' }));
    await declare(MONDAY, 'Diwali').expect(200);

    for (const classCode of ['5', '7']) {
      const res = await as.get(`/api/v1/attendance/roster?classCode=${classCode}&dateKey=${MONDAY}`).expect(200);
      expect(res.body.holiday).toEqual({ dateKey: MONDAY, label: 'Diwali' });
      expect(res.body.entries.every((e: { status: string }) => e.status === 'HOLIDAY')).toBe(true);
    }

    // The point of deriving it: nothing was written to the attendance collection at all.
    expect(await Attendance.countDocuments({ dateKey: MONDAY })).toBe(0);
  });

  it('covers a student enrolled after the holiday was declared', async () => {
    await declare(MONDAY, 'Diwali').expect(200);
    const late = await createStudent(studentInput({ fullName: 'Diya Verma', classCode: '5' }));

    const res = await as.get(`/api/v1/attendance/roster?classCode=5&dateKey=${MONDAY}`).expect(200);
    const entry = res.body.entries.find((e: { studentId: string }) => e.studentId === late.studentId);
    expect(entry.status).toBe('HOLIDAY');
  });

  it('refuses attendance for the day, naming the holiday', async () => {
    await declare(MONDAY, 'Diwali').expect(200);

    const res = await as
      .put('/api/v1/attendance/roster')
      .send({ classCode: '5', dateKey: MONDAY, marks: [{ studentId, status: 'PRESENT' }] })
      .expect(400);
    expect(res.body.error.message).toContain('Diwali');
  });

  it('closes the teacher register too', async () => {
    const anita = await createTestUser({
      role: 'TEACHER',
      name: 'Anita Rao',
      email: 'anita@school.test',
      assignedClasses: ['5'],
    });
    await declare(MONDAY, 'Diwali').expect(200);

    const roster = await as.get(`/api/v1/attendance/staff/roster?dateKey=${MONDAY}`).expect(200);
    expect(roster.body.entries[0].status).toBe('HOLIDAY');

    await as
      .put('/api/v1/attendance/staff/roster')
      .send({ dateKey: MONDAY, marks: [{ userId: String(anita._id), status: 'PRESENT' }] })
      .expect(400);
  });

  it('stops nudging about unmarked classes', async () => {
    expect(await getUnmarkedClasses(MONDAY)).toContain('5');
    await declare(MONDAY, 'Diwali').expect(200);
    expect(await getUnmarkedClasses(MONDAY)).toEqual([]);
  });

  it('renames rather than duplicating when the same day is declared twice', async () => {
    await declare(MONDAY, 'Diwali').expect(200);
    const res = await declare(MONDAY, 'Deepavali').expect(200);

    expect(res.body.holidays).toEqual([{ dateKey: MONDAY, label: 'Deepavali' }]);
  });

  it('rejects a Sunday, which is already a holiday for everyone', async () => {
    await declare(SUNDAY, 'Diwali').expect(400);
  });

  it('is refused to a teacher, since it closes the whole school', async () => {
    const { header } = await teacherAuth(['5']);
    await request(app)
      .post('/api/v1/attendance/holiday')
      .set('Authorization', header)
      .send({ dateKey: MONDAY, label: 'Diwali' })
      .expect(403);
  });
});

describe('what a holiday does to the figures', () => {
  it('counts as a holiday in the monthly grid, not as a working day', async () => {
    await as
      .put('/api/v1/attendance/roster')
      .send({ classCode: '5', dateKey: TUESDAY, marks: [{ studentId, status: 'PRESENT' }] })
      .expect(200);
    await declare(MONDAY, 'Diwali').expect(200);

    const res = await as.get('/api/v1/attendance/monthly?classCode=5&month=2026-08').expect(200);
    const row = res.body.rows[0];

    expect(res.body.holidays[MONDAY]).toBe('Diwali');
    expect(row.days[MONDAY]).toBe('HOLIDAY');
    // 5 Sundays in August 2026, plus the declared Monday.
    expect(row.totals).toMatchObject({ present: 1, absent: 0, holiday: 6, workingDays: 1, percentage: 100 });
  });

  it('discards a mark saved before the day was declared a holiday', async () => {
    await as
      .put('/api/v1/attendance/roster')
      .send({ classCode: '5', dateKey: MONDAY, marks: [{ studentId, status: 'ABSENT' }] })
      .expect(200);
    await declare(MONDAY, 'Diwali').expect(200);

    // The record is still on disk — it is simply no longer read, exactly as for a Sunday.
    expect(await Attendance.countDocuments({ dateKey: MONDAY })).toBe(1);

    const res = await as.get(`/api/v1/attendance/student/${studentId}`).expect(200);
    expect(res.body.records).toEqual([]);
    expect(res.body.totals).toMatchObject({ absent: 0, workingDays: 0 });
  });

  it('keeps a holiday out of the defaulters report', async () => {
    await as
      .put('/api/v1/attendance/roster')
      .send({ classCode: '5', dateKey: MONDAY, marks: [{ studentId, status: 'ABSENT' }] })
      .expect(200);

    const before = await as.get('/api/v1/attendance/defaulters?month=2026-08&threshold=75').expect(200);
    expect(before.body.items).toHaveLength(1);

    await declare(MONDAY, 'Diwali').expect(200);

    // No working days left, so the student is not 0% — they are simply not a defaulter.
    const after = await as.get('/api/v1/attendance/defaulters?month=2026-08&threshold=75').expect(200);
    expect(after.body.items).toEqual([]);
  });
});

describe('clearing a holiday', () => {
  it('reopens the day for marking', async () => {
    await declare(MONDAY, 'Diwali').expect(200);
    const res = await as.delete(`/api/v1/attendance/holiday?dateKey=${MONDAY}`).expect(200);
    expect(res.body.holidays).toEqual([]);

    await as
      .put('/api/v1/attendance/roster')
      .send({ classCode: '5', dateKey: MONDAY, marks: [{ studentId, status: 'PRESENT' }] })
      .expect(200);
  });

  it('refuses to clear a Sunday, which is derived and not stored', async () => {
    await as.delete(`/api/v1/attendance/holiday?dateKey=${SUNDAY}`).expect(400);
  });

  it('is refused to a teacher', async () => {
    const { header } = await teacherAuth(['5']);
    await request(app)
      .delete(`/api/v1/attendance/holiday?dateKey=${MONDAY}`)
      .set('Authorization', header)
      .expect(403);
  });
});
