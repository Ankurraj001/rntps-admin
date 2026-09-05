import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { AuditLog } from '../../models/AuditLog.js';
import { ExamResult } from '../../models/ExamResult.js';
import { SETTINGS_ID, Settings } from '../../models/Settings.js';
import { Student } from '../../models/Student.js';
import { adminAuth, seedSettings, studentInput, teacherAuth } from '../../test/factories.js';
import { createStudent } from '../students/student.service.js';

let app: Express;
let adminHeader: string;

/** The session seedSettings() pins, so every test agrees on what "in progress" means. */
const YEAR = '2026-27';
const LAST_YEAR = '2025-26';

const blank = { UT1: null, UT2: null, HALF_YEARLY: null, UT3: null, UT4: null, FINAL: null };

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

function saveMarks(header: string, studentId: string, scores: Record<string, number | null>, academicYear = YEAR) {
  return request(app)
    .put('/api/v1/academics/marks')
    .set('Authorization', header)
    .send({ studentId, academicYear, scores: { ...blank, ...scores } });
}

beforeEach(async () => {
  await seedSettings();
  app = createApp();
  adminHeader = (await adminAuth()).header;
});

describe('PUT /academics/marks', () => {
  it('saves marks and reads them back', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    await saveMarks(adminHeader, studentId!, { UT1: 87.5, HALF_YEARLY: 91.25 }).expect(200);

    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(stored?.scores.UT1).toBe(87.5);
    expect(stored?.scores.HALF_YEARLY).toBe(91.25);
    expect(stored?.scores.UT2).toBeNull();

    const res = await request(app)
      .get('/api/v1/academics')
      .query({ academicYear: YEAR, classCode: '5' })
      .set('Authorization', adminHeader)
      .expect(200);

    expect(res.body.items[0]).toMatchObject({
      studentId,
      fullName: 'Aarav Sharma',
      classCode: '5',
      rollNo: 1,
      hasRecord: true,
    });
    expect(res.body.items[0].scores.UT1).toBe(87.5);
  });

  it('overwrites on re-save, so correcting a mark needs no special case', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    await saveMarks(adminHeader, studentId!, { UT1: 40 }).expect(200);
    await saveMarks(adminHeader, studentId!, { UT1: 62.75 }).expect(200);

    expect(await ExamResult.countDocuments()).toBe(1);
    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(stored?.scores.UT1).toBe(62.75);
  });

  it('rejects a third decimal rather than rounding it', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    const res = await saveMarks(adminHeader, studentId!, { UT1: 87.555 }).expect(400);
    expect(res.body.error.message).toMatch(/correct the highlighted fields/i);
    expect(res.body.error.details).toContainEqual(
      expect.objectContaining({ message: expect.stringMatching(/two decimal places/i) }),
    );
    expect(await ExamResult.countDocuments()).toBe(0);
  });

  it('rejects a mark above 100 or below 0', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    await saveMarks(adminHeader, studentId!, { UT1: 101 }).expect(400);
    await saveMarks(adminHeader, studentId!, { UT2: -1 }).expect(400);
    expect(await ExamResult.countDocuments()).toBe(0);
  });

  it('accepts 0 as a real mark, distinct from an unrecorded one', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    await saveMarks(adminHeader, studentId!, { UT1: 0 }).expect(200);

    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(stored?.scores.UT1).toBe(0);
    expect(stored?.scores.UT2).toBeNull();
  });

  it('refuses to open a new card for a session that is not in progress', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    const res = await saveMarks(adminHeader, studentId!, { UT1: 70 }, LAST_YEAR).expect(400);
    expect(res.body.error.message).toMatch(/session in progress/i);
    expect(await ExamResult.countDocuments()).toBe(0);
  });

  it('records the save in the audit log', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: 70 }).expect(200);

    expect(await AuditLog.countDocuments({ action: 'academics.save' })).toBe(1);
  });

  it('404s for a student that does not exist', async () => {
    await saveMarks(adminHeader, 'RNTPS-26-999', { UT1: 70 }).expect(404);
  });
});

describe('GET /academics', () => {
  it('lists every enrolled student, with no marks recorded yet', async () => {
    await seedClass('5', ['Aarav Sharma', 'Diya Verma']);

    const res = await request(app)
      .get('/api/v1/academics')
      .query({ classCode: '5' })
      .set('Authorization', adminHeader)
      .expect(200);

    expect(res.body.total).toBe(2);
    expect(res.body.items.map((row: { hasRecord: boolean }) => row.hasRecord)).toEqual([false, false]);
    expect(res.body.items[0].scores).toEqual(blank);
  });

  it('defaults to the session in progress', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: 55 }).expect(200);

    const res = await request(app).get('/api/v1/academics').set('Authorization', adminHeader).expect(200);
    expect(res.body.items[0].academicYear).toBe(YEAR);
    expect(res.body.items[0].scores.UT1).toBe(55);
  });

  it('filters by name', async () => {
    await seedClass('5', ['Aarav Sharma', 'Diya Verma']);

    const res = await request(app)
      .get('/api/v1/academics')
      .query({ q: 'diya' })
      .set('Authorization', adminHeader)
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.items[0].fullName).toBe('Diya Verma');
  });

  it('sorts unmarked students last in both directions', async () => {
    const [low, high, unmarked] = await seedClass('5', ['Aarav Sharma', 'Diya Verma', 'Kabir Nair']);
    await saveMarks(adminHeader, low!, { UT1: 40 }).expect(200);
    await saveMarks(adminHeader, high!, { UT1: 90 }).expect(200);

    const ascending = await request(app)
      .get('/api/v1/academics')
      .query({ sort: 'UT1', order: 'asc' })
      .set('Authorization', adminHeader)
      .expect(200);
    expect(ascending.body.items.map((r: { studentId: string }) => r.studentId)).toEqual([low, high, unmarked]);

    const descending = await request(app)
      .get('/api/v1/academics')
      .query({ sort: 'UT1', order: 'desc' })
      .set('Authorization', adminHeader)
      .expect(200);
    expect(descending.body.items.map((r: { studentId: string }) => r.studentId)).toEqual([high, low, unmarked]);
  });

  it('defaults to register order — roll number, then name', async () => {
    const [first, second] = await seedClass('5', ['Zoya Khan', 'Aarav Sharma']);

    const res = await request(app).get('/api/v1/academics').set('Authorization', adminHeader).expect(200);
    expect(res.body.items.map((r: { studentId: string }) => r.studentId)).toEqual([first, second]);
  });

  it('paginates', async () => {
    await seedClass('5', ['Aarav Sharma', 'Diya Verma', 'Kabir Nair']);

    const res = await request(app)
      .get('/api/v1/academics')
      .query({ page: 2, limit: 2 })
      .set('Authorization', adminHeader)
      .expect(200);

    expect(res.body).toMatchObject({ page: 2, limit: 2, total: 3, totalPages: 2 });
    expect(res.body.items).toHaveLength(1);
  });

  it('reads a closed session from the snapshots, after promotion has moved everyone on', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: 88 }).expect(200);

    // What a rollover does to the live record: up a class, new session, roll number cleared.
    await Student.updateOne(
      { _id: studentId },
      { $set: { classCode: '6', academicYear: '2027-28', rollNo: null } },
    );
    await Settings.updateOne({ _id: SETTINGS_ID }, { $set: { activeAcademicYear: '2027-28' } });

    const closed = await request(app)
      .get('/api/v1/academics')
      .query({ academicYear: YEAR })
      .set('Authorization', adminHeader)
      .expect(200);

    expect(closed.body.items).toHaveLength(1);
    expect(closed.body.items[0]).toMatchObject({ classCode: '5', rollNo: 1, hasRecord: true });
    expect(closed.body.items[0].scores.UT1).toBe(88);

    const current = await request(app).get('/api/v1/academics').set('Authorization', adminHeader).expect(200);
    expect(current.body.items[0]).toMatchObject({ classCode: '6', rollNo: null, hasRecord: false });
  });

  it('shows the current name but the session\'s class for an archived row', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: 88 }).expect(200);
    await Student.updateOne({ _id: studentId }, { $set: { fullName: 'Aarav Sharma-Verma' } });

    const res = await request(app).get('/api/v1/academics').set('Authorization', adminHeader).expect(200);
    expect(res.body.items[0].fullName).toBe('Aarav Sharma-Verma');
  });
});

describe('GET /academics/years', () => {
  it('offers the session in progress even with nothing recorded', async () => {
    const res = await request(app).get('/api/v1/academics/years').set('Authorization', adminHeader).expect(200);
    expect(res.body).toEqual({ years: [YEAR], activeAcademicYear: YEAR });
  });

  it('adds every session with marks on record, newest first', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: 70 }).expect(200);
    await Settings.updateOne({ _id: SETTINGS_ID }, { $set: { activeAcademicYear: '2027-28' } });

    const res = await request(app).get('/api/v1/academics/years').set('Authorization', adminHeader).expect(200);
    expect(res.body.years).toEqual(['2027-28', YEAR]);
  });
});

describe('GET /academics/student/:studentId', () => {
  it('returns every session on record, newest first', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: 70 }).expect(200);

    await Settings.updateOne({ _id: SETTINGS_ID }, { $set: { activeAcademicYear: '2027-28' } });
    await Student.updateOne({ _id: studentId }, { $set: { classCode: '6', academicYear: '2027-28' } });
    await saveMarks(adminHeader, studentId!, { UT1: 81 }, '2027-28').expect(200);

    const res = await request(app)
      .get(`/api/v1/academics/student/${studentId}`)
      .set('Authorization', adminHeader)
      .expect(200);

    expect(res.body.years.map((y: { academicYear: string }) => y.academicYear)).toEqual(['2027-28', YEAR]);
    expect(res.body.years[0]).toMatchObject({ classCode: '6' });
    expect(res.body.years[1]).toMatchObject({ classCode: '5' });
  });

  it('returns an empty history for a student with no marks', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    const res = await request(app)
      .get(`/api/v1/academics/student/${studentId}`)
      .set('Authorization', adminHeader)
      .expect(200);

    expect(res.body.years).toEqual([]);
  });

  it('404s for a student that does not exist', async () => {
    await request(app)
      .get('/api/v1/academics/student/RNTPS-26-999')
      .set('Authorization', adminHeader)
      .expect(404);
  });
});

describe('authorisation', () => {
  it('lets a teacher save marks for their own class', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    const { header } = await teacherAuth(['5']);

    await saveMarks(header, studentId!, { UT1: 77 }).expect(200);
  });

  it('refuses a teacher saving marks for another class', async () => {
    const [outsider] = await seedClass('6', ['Kabir Nair']);
    const { header } = await teacherAuth(['5']);

    const res = await saveMarks(header, outsider!, { UT1: 77 }).expect(403);
    expect(res.body.error.message).toMatch(/not assigned to 6/i);
    expect(await ExamResult.countDocuments()).toBe(0);
  });

  it('confines a teacher\'s gradebook to their own classes', async () => {
    await seedClass('5', ['Aarav Sharma']);
    await seedClass('6', ['Kabir Nair']);
    const { header } = await teacherAuth(['5']);

    const res = await request(app).get('/api/v1/academics').set('Authorization', header).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].classCode).toBe('5');
  });

  it('refuses, rather than silently empties, a teacher asking for another class', async () => {
    await seedClass('6', ['Kabir Nair']);
    const { header } = await teacherAuth(['5']);

    const res = await request(app)
      .get('/api/v1/academics')
      .query({ classCode: '6' })
      .set('Authorization', header)
      .expect(403);
    expect(res.body.error.message).toMatch(/not assigned to 6/i);
  });

  it('gates the class check on the student record, not on anything in the body', async () => {
    const [outsider] = await seedClass('6', ['Kabir Nair']);
    const { header } = await teacherAuth(['5']);

    // Naming an allowed class in the payload must not buy access to a class-6 student.
    await request(app)
      .put('/api/v1/academics/marks')
      .set('Authorization', header)
      .send({ studentId: outsider, academicYear: YEAR, classCode: '5', scores: { ...blank, UT1: 77 } })
      .expect(403);
  });

  it('requires a signed-in user', async () => {
    await request(app).get('/api/v1/academics').expect(401);
    await request(app).get('/api/v1/academics/years').expect(401);
    await request(app).put('/api/v1/academics/marks').send({}).expect(401);
  });
});
