import { ATTENDANCE_STATUSES, isSunday } from '@rntps/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { Attendance } from '../../models/Attendance.js';
import { StaffAttendance } from '../../models/StaffAttendance.js';
import { adminAuth, createTestUser, seedSettings, studentInput } from '../../test/factories.js';
import { createStudent } from '../students/student.service.js';
import { getUnmarkedClasses } from './attendance.service.js';

/**
 * Sunday is a holiday for every class, without anyone declaring it.
 *
 * It is derived rather than stored, which is the point: the rule applies to every past
 * date with no backfill, and a stray mark saved before the rule existed cannot quietly
 * count toward anyone's attendance.
 */

let app: Express;
let adminHeader: string;
let studentId: string;
let teacherId: string;

// August 2026 — the 2nd, 9th, 16th, 23rd and 30th are Sundays; the 3rd is a Monday.
const SUNDAY = '2026-08-02';
const MONDAY = '2026-08-03';

const as = {
  get: (p: string) => request(app).get(p).set('Authorization', adminHeader),
  put: (p: string) => request(app).put(p).set('Authorization', adminHeader),
};

beforeEach(async () => {
  await seedSettings();
  app = createApp();
  adminHeader = (await adminAuth()).header;
  const student = await createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));
  studentId = student.studentId;
  const teacher = await createTestUser({
    role: 'TEACHER',
    name: 'Anita Rao',
    email: 'anita@school.test',
    assignedClasses: ['5'],
  });
  teacherId = String(teacher._id);
});

describe('the status list itself', () => {
  it('offers only present, absent and holiday', () => {
    expect([...ATTENDANCE_STATUSES]).toEqual(['PRESENT', 'ABSENT', 'HOLIDAY']);
  });

  it('rejects a retired status at the edge', async () => {
    for (const status of ['LATE', 'LEAVE']) {
      await as
        .put('/api/v1/attendance/roster')
        .send({ classCode: '5', dateKey: MONDAY, marks: [{ studentId, status }] })
        .expect(400);
    }
  });

  it('identifies Sundays independently of the machine timezone', () => {
    expect(isSunday('2026-08-02')).toBe(true);
    expect(isSunday('2026-08-30')).toBe(true);
    expect(isSunday('2026-08-03')).toBe(false);
  });
});

describe('the roster on a Sunday', () => {
  it('reports the day as a holiday without one being declared', async () => {
    const res = await as.get('/api/v1/attendance/roster').query({ classCode: '5', dateKey: SUNDAY }).expect(200);

    expect(res.body.isSunday).toBe(true);
    expect(res.body.holiday).toEqual({ dateKey: SUNDAY, label: 'Sunday' });
    expect(res.body.entries.every((e: { status: string }) => e.status === 'HOLIDAY')).toBe(true);
  });

  it('refuses to save, rather than accepting marks it would ignore', async () => {
    const res = await as
      .put('/api/v1/attendance/roster')
      .send({ classCode: '5', dateKey: SUNDAY, marks: [{ studentId, status: 'PRESENT' }] })
      .expect(400);

    expect(res.body.error.message).toContain('Sunday');
    expect(await Attendance.countDocuments({})).toBe(0);
  });

  it('still saves normally on a weekday', async () => {
    await as
      .put('/api/v1/attendance/roster')
      .send({ classCode: '5', dateKey: MONDAY, marks: [{ studentId, status: 'PRESENT' }] })
      .expect(200);
    expect(await Attendance.countDocuments({})).toBe(1);
  });
});

describe('Sundays in the monthly grid', () => {
  it('marks every Sunday as a holiday and keeps them out of working days', async () => {
    await as
      .put('/api/v1/attendance/roster')
      .send({ classCode: '5', dateKey: MONDAY, marks: [{ studentId, status: 'PRESENT' }] })
      .expect(200);

    const res = await as.get('/api/v1/attendance/monthly').query({ classCode: '5', month: '2026-08' }).expect(200);

    expect(Object.keys(res.body.holidays).sort()).toEqual([
      '2026-08-02',
      '2026-08-09',
      '2026-08-16',
      '2026-08-23',
      '2026-08-30',
    ]);
    const row = res.body.rows[0];
    expect(row.days[SUNDAY]).toBe('HOLIDAY');
    // One working day marked present; the five Sundays are holidays.
    expect(row.totals).toMatchObject({ present: 1, holiday: 5, workingDays: 1 });
    expect(row.totals.percentage).toBe(100);
  });

  it('overrides a mark saved on a Sunday before the rule existed', async () => {
    // Written straight to the collection, as a pre-rule record would have been.
    await Attendance.create({
      _id: `${studentId}:${SUNDAY}`,
      studentId,
      classCode: '5',
      dateKey: SUNDAY,
      status: 'ABSENT',
      remarks: '',
      markedBy: 'legacy',
      markedAt: new Date(),
    });

    const res = await as.get('/api/v1/attendance/monthly').query({ classCode: '5', month: '2026-08' }).expect(200);
    const row = res.body.rows[0];

    // The stored ABSENT is ignored: it must not drag the percentage down.
    expect(row.days[SUNDAY]).toBe('HOLIDAY');
    expect(row.totals).toMatchObject({ absent: 0, holiday: 5, workingDays: 0 });
  });

  it('leaves a student history free of Sundays', async () => {
    await Attendance.create({
      _id: `${studentId}:${SUNDAY}`,
      studentId,
      classCode: '5',
      dateKey: SUNDAY,
      status: 'ABSENT',
      remarks: '',
      markedBy: 'legacy',
      markedAt: new Date(),
    });

    const res = await as.get(`/api/v1/attendance/student/${studentId}`).expect(200);
    expect(res.body.records).toEqual([]);
    expect(res.body.totals).toMatchObject({ absent: 0, workingDays: 0 });
  });
});

/**
 * The rule covers the teacher register too, because both services call the same extracted
 * helpers rather than each deriving Sunday for themselves.
 */
describe('the teacher register on a Sunday', () => {
  it('reads as a holiday and cannot be marked', async () => {
    const roster = await as.get(`/api/v1/attendance/staff/roster?dateKey=${SUNDAY}`).expect(200);
    expect(roster.body.isSunday).toBe(true);
    expect(roster.body.holiday).toMatchObject({ label: 'Sunday' });
    expect(roster.body.entries[0]).toMatchObject({ status: 'HOLIDAY' });

    const refused = await as
      .put('/api/v1/attendance/staff/roster')
      .send({ dateKey: SUNDAY, marks: [{ userId: teacherId, status: 'PRESENT' }] })
      .expect(400);
    expect(refused.body.error.message).toMatch(/Sunday/);

    // Refused, rather than accepted and then ignored.
    expect(await StaffAttendance.countDocuments()).toBe(0);
  });

  it('overrides a mark saved on a Sunday before the rule existed', async () => {
    await StaffAttendance.create({
      _id: `${teacherId}:${SUNDAY}`,
      userId: teacherId,
      dateKey: SUNDAY,
      status: 'ABSENT',
      remarks: '',
      markedBy: 'legacy',
      markedAt: new Date(),
    });

    const res = await as.get('/api/v1/attendance/staff/monthly?month=2026-08').expect(200);
    const row = res.body.rows[0];

    expect(row.days[SUNDAY]).toBe('HOLIDAY');
    expect(row.totals).toMatchObject({ absent: 0, holiday: 5, workingDays: 0 });
  });
});

describe('the unmarked-classes nudge', () => {
  // Exercised through the service: the route always asks about today, so the date cannot
  // be varied over HTTP.
  it('says nothing on a Sunday, since there is nothing to mark', async () => {
    expect(await getUnmarkedClasses(SUNDAY)).toEqual([]);
  });

  it('still nudges on a weekday', async () => {
    expect(await getUnmarkedClasses(MONDAY)).toContain('5');
  });
});
