import type { Express } from 'express';
import request from 'supertest';
import { toDateKey } from '@rntps/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { StaffAttendance } from '../../models/StaffAttendance.js';
import { Attendance } from '../../models/Attendance.js';
import {
  adminAuth,
  createTestUser,
  seedSettings,
  studentInput,
  teacherAuth,
  tokenFor,
} from '../../test/factories.js';
import { createStudent } from '../students/student.service.js';

let app: Express;
let adminHeader: string;
let adminId: string;

// August 2026: the 24th is a Monday, the 2nd a Sunday.
const TODAY = '2026-08-24';
const SUNDAY = '2026-08-02';

const asAdmin = {
  get: (path: string) => request(app).get(path).set('Authorization', adminHeader),
  put: (path: string) => request(app).put(path).set('Authorization', adminHeader),
};

/** Distinct emails per call: `email` is uniquely indexed. */
async function seedTeacher(name: string) {
  const user = await createTestUser({
    role: 'TEACHER',
    name,
    email: `${name.toLowerCase().replace(/\W+/g, '.')}@school.test`,
    assignedClasses: ['5'],
  });
  return String(user._id);
}

beforeEach(async () => {
  await seedSettings();
  app = createApp();
  const admin = await adminAuth();
  adminHeader = admin.header;
  adminId = String(admin.user._id);
});

describe('PUT /attendance/staff/roster', () => {
  it('saves a teacher roster and reads it back', async () => {
    const anita = await seedTeacher('Anita Rao');
    const bhaskar = await seedTeacher('Bhaskar Nair');

    await asAdmin
      .put('/api/v1/attendance/staff/roster')
      .send({
        dateKey: TODAY,
        marks: [
          { userId: anita, status: 'PRESENT' },
          { userId: bhaskar, status: 'ABSENT', remarks: 'Fever' },
        ],
      })
      .expect(200);

    const roster = await asAdmin
      .get(`/api/v1/attendance/staff/roster?dateKey=${TODAY}`)
      .expect(200);

    expect(roster.body.entries).toHaveLength(2);
    // Alphabetical by name, like the Users page.
    expect(roster.body.entries[0]).toMatchObject({ userId: anita, name: 'Anita Rao', status: 'PRESENT' });
    expect(roster.body.entries[1]).toMatchObject({ userId: bhaskar, status: 'ABSENT', remarks: 'Fever' });
    expect(roster.body.submittedBy).toEqual(expect.any(String));
  });

  it('is idempotent — resubmitting corrects rather than duplicating', async () => {
    const anita = await seedTeacher('Anita Rao');

    for (const status of ['PRESENT', 'ABSENT']) {
      await asAdmin
        .put('/api/v1/attendance/staff/roster')
        .send({ dateKey: TODAY, marks: [{ userId: anita, status }] })
        .expect(200);
    }

    expect(await StaffAttendance.countDocuments()).toBe(1);
    const record = await StaffAttendance.findById(`${anita}:${TODAY}`).lean();
    expect(record?.status).toBe('ABSENT');
  });

  it('records who marked it', async () => {
    const anita = await seedTeacher('Anita Rao');

    await asAdmin
      .put('/api/v1/attendance/staff/roster')
      .send({ dateKey: TODAY, marks: [{ userId: anita, status: 'PRESENT' }] })
      .expect(200);

    const record = await StaffAttendance.findById(`${anita}:${TODAY}`).lean();
    expect(record?.markedBy).toBe(adminId);
  });

  it('refuses a future date', async () => {
    const anita = await seedTeacher('Anita Rao');
    const res = await asAdmin
      .put('/api/v1/attendance/staff/roster')
      .send({ dateKey: '2099-01-04', marks: [{ userId: anita, status: 'PRESENT' }] })
      .expect(400);
    expect(res.body.error.message).toMatch(/future/i);
  });

  it('refuses anyone who is not an active teacher', async () => {
    const departed = await createTestUser({
      role: 'TEACHER',
      name: 'Departed',
      email: 'departed@school.test',
      assignedClasses: ['5'],
      isActive: false,
    });
    const student = await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));

    for (const userId of [adminId, String(departed._id)]) {
      const res = await asAdmin
        .put('/api/v1/attendance/staff/roster')
        .send({ dateKey: TODAY, marks: [{ userId, status: 'PRESENT' }] })
        .expect(400);
      expect(res.body.error.message).toMatch(/not on the teacher roll/i);
    }

    // A studentId is not even the right shape, so it is rejected at the schema edge.
    await asAdmin
      .put('/api/v1/attendance/staff/roster')
      .send({ dateKey: TODAY, marks: [{ userId: student.studentId, status: 'PRESENT' }] })
      .expect(400);
  });

  it('treats a user id case-insensitively, so one teacher-day is never two documents', async () => {
    const anita = await seedTeacher('Anita Rao');

    for (const userId of [anita, anita.toUpperCase()]) {
      await asAdmin
        .put('/api/v1/attendance/staff/roster')
        .send({ dateKey: TODAY, marks: [{ userId, status: 'PRESENT' }] })
        .expect(200);
    }

    expect(await StaffAttendance.countDocuments()).toBe(1);
  });
});

describe('the teacher roster', () => {
  it('leaves out admins and deactivated teachers', async () => {
    await seedTeacher('Anita Rao');
    await createTestUser({ role: 'TEACHER', name: 'Gone', email: 'gone@school.test', isActive: false });
    // adminAuth() in beforeEach already seeded an admin.

    const res = await asAdmin.get(`/api/v1/attendance/staff/roster?dateKey=${TODAY}`).expect(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].name).toBe('Anita Rao');
  });

  it('is empty rather than an error at a school with no teachers yet', async () => {
    const roster = await asAdmin.get(`/api/v1/attendance/staff/roster?dateKey=${TODAY}`).expect(200);
    expect(roster.body.entries).toEqual([]);

    const monthly = await asAdmin.get('/api/v1/attendance/staff/monthly?month=2026-08').expect(200);
    expect(monthly.body.rows).toEqual([]);
  });
});

describe('the teacher monthly grid', () => {
  it('computes the percentage over working days, excluding holidays', async () => {
    const anita = await seedTeacher('Anita Rao');
    const marks: [string, string][] = [
      ['2026-08-03', 'PRESENT'],
      ['2026-08-04', 'PRESENT'],
      ['2026-08-05', 'PRESENT'],
      ['2026-08-06', 'ABSENT'],
      ['2026-08-07', 'HOLIDAY'],
    ];

    for (const [dateKey, status] of marks) {
      await asAdmin
        .put('/api/v1/attendance/staff/roster')
        .send({ dateKey, marks: [{ userId: anita, status }] })
        .expect(200);
    }

    const res = await asAdmin.get('/api/v1/attendance/staff/monthly?month=2026-08').expect(200);

    // Same arithmetic as a student's row: 3 present of 4 working days, and `holiday` is the
    // one declared day plus August 2026's five Sundays.
    const row = res.body.rows[0];
    expect(row.totals).toMatchObject({ present: 3, absent: 1, holiday: 6, workingDays: 4 });
    expect(row.totals.percentage).toBe(75);
  });

  it('returns every day of the month, so the grid has fixed columns', async () => {
    await seedTeacher('Anita Rao');
    const res = await asAdmin.get('/api/v1/attendance/staff/monthly?month=2026-02').expect(200);
    expect(res.body.dateKeys).toHaveLength(28);
    expect(res.body.holidays[SUNDAY]).toBeUndefined();
    expect(res.body.holidays['2026-02-01']).toBe('Sunday');
  });

  it('rejects a malformed month', async () => {
    await asAdmin.get('/api/v1/attendance/staff/monthly?month=2026-13').expect(400);
  });

  it('carries a name and nothing else about the user', async () => {
    const anita = await seedTeacher('Anita Rao');
    const res = await asAdmin.get('/api/v1/attendance/staff/monthly?month=2026-08').expect(200);

    // Any signed-in user can read this, so it must not become a staff directory.
    expect(Object.keys(res.body.rows[0]).sort()).toEqual(['days', 'name', 'totals', 'userId']);
    expect(res.body.rows[0].userId).toBe(anita);
    expect(JSON.stringify(res.body)).not.toContain('@');
  });
});

describe('access control', () => {
  it('lets a teacher read the whole grid but not the roster, and not mark', async () => {
    const anita = await seedTeacher('Anita Rao');
    const { header } = await teacherAuth();

    await request(app)
      .get('/api/v1/attendance/staff/monthly?month=2026-08')
      .set('Authorization', header)
      .expect(200);

    await request(app)
      .get(`/api/v1/attendance/staff/roster?dateKey=${TODAY}`)
      .set('Authorization', header)
      .expect(403);

    await request(app)
      .put('/api/v1/attendance/staff/roster')
      .set('Authorization', header)
      .send({ dateKey: TODAY, marks: [{ userId: anita, status: 'PRESENT' }] })
      .expect(403);
  });

  it('does not ask a teacher for a class they cannot supply', async () => {
    const teacher = await createTestUser({
      role: 'TEACHER',
      email: 'noclass@school.test',
      assignedClasses: ['5'],
    });

    // requireClassAccess() would reject this with "A class must be specified"; the staff
    // routes carry no classCode, so it must not be in their chain.
    const res = await request(app)
      .get('/api/v1/attendance/staff/monthly?month=2026-08')
      .set('Authorization', `Bearer ${await tokenFor(teacher)}`)
      .expect(200);
    expect(res.body.rows).toEqual(expect.any(Array));
  });

  it('requires a signed-in user', async () => {
    await request(app).get('/api/v1/attendance/staff/monthly?month=2026-08').expect(401);
    await request(app).get(`/api/v1/attendance/staff/roster?dateKey=${TODAY}`).expect(401);
  });
});

describe('separation from student attendance', () => {
  it('keeps teacher marks in their own collection, out of every student report', async () => {
    const anita = await seedTeacher('Anita Rao');
    const student = await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));

    await asAdmin
      .put('/api/v1/attendance/roster')
      .send({ classCode: '5', dateKey: TODAY, marks: [{ studentId: student.studentId, status: 'PRESENT' }] })
      .expect(200);
    await asAdmin
      .put('/api/v1/attendance/staff/roster')
      .send({ dateKey: TODAY, marks: [{ userId: anita, status: 'ABSENT' }] })
      .expect(200);

    expect(await Attendance.countDocuments()).toBe(1);
    expect(await StaffAttendance.countDocuments()).toBe(1);

    // The defaulter report is a student report. An absent teacher is not a defaulter.
    const defaulters = await asAdmin
      .get('/api/v1/attendance/defaulters?month=2026-08&threshold=100')
      .expect(200);
    expect(defaulters.body.items).toHaveLength(0);
  });

  it('does not let an absent teacher move the dashboard figure', async () => {
    const anita = await seedTeacher('Anita Rao');
    const student = await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));

    // The dashboard's "today" is toDateKey(), so both rows are written directly rather than
    // through the routes — which would refuse the real date if it happened to be a Sunday.
    const today = toDateKey();
    const markedAt = new Date();
    await Attendance.create({
      _id: `${student.studentId}:${today}`,
      studentId: student.studentId,
      classCode: '5',
      dateKey: today,
      status: 'PRESENT',
      markedBy: adminId,
      markedAt,
    });
    await StaffAttendance.create({
      _id: `${anita}:${today}`,
      userId: anita,
      dateKey: today,
      status: 'ABSENT',
      markedBy: adminId,
      markedAt,
    });

    // getDashboard counts every row of `attendances` for today with no class filter, which
    // is the whole reason teacher attendance lives elsewhere: one absent teacher must not
    // drag the school's "present today" to 50%.
    const res = await asAdmin.get('/api/v1/reports/dashboard').expect(200);
    expect(res.body.today).toMatchObject({ marked: 1, present: 1, percentage: 100 });
  });
});
