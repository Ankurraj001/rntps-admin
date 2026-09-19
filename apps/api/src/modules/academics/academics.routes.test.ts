import {
  emptyScores,
  emptySubjectGrades,
  emptySubjectMarks,
  subjectsForClass,
  type ExamCode,
  type ExamScores,
  type GradedSubjectCode,
  type SubjectCode,
} from '@rntps/shared';
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

type Paper = Partial<Record<SubjectCode, number | null>>;
type Card = Partial<Record<ExamCode, Paper>>;
type GradedPaper = Partial<Record<GradedSubjectCode, string | null>>;
type GradeCard = Partial<Record<ExamCode, GradedPaper>>;

/** A full card with only the named papers filled in — what every save actually posts. */
function card(papers: Card) {
  const full = emptySubjectMarks();
  for (const [exam, marks] of Object.entries(papers)) {
    Object.assign(full[exam as ExamCode], marks);
  }
  return full;
}

/**
 * Every subject of a class marked the same, so an expected percentage is the mark over the
 * paper's maximum and needs no arithmetic in the assertion.
 */
function everySubject(classCode: string, mark: number): Paper {
  return Object.fromEntries(subjectsForClass(classCode).map((subject) => [subject, mark]));
}

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

function gradeCard(papers: GradeCard) {
  const full = emptySubjectGrades();
  for (const [exam, grades] of Object.entries(papers)) {
    Object.assign(full[exam as ExamCode], grades);
  }
  return full;
}

function saveMarks(
  header: string,
  studentId: string,
  papers: Card,
  academicYear = YEAR,
  grades: GradeCard = {},
) {
  return request(app)
    .put('/api/v1/academics/marks')
    .set('Authorization', header)
    .send({
      studentId,
      academicYear,
      subjectMarks: card(papers),
      subjectGrades: gradeCard(grades),
    });
}

/**
 * A record as it was written before subject-wise entry: a percentage and no `subjectMarks`
 * key at all. Inserted through the driver rather than the model, because the model's
 * defaults would helpfully add the very field these tests need to be missing.
 */
async function seedLegacyRecord(studentId: string, classCode: string, scores: Partial<ExamScores>) {
  await ExamResult.collection.insertOne({
    _id: `${studentId}:${YEAR}`,
    studentId,
    academicYear: YEAR,
    studentNameSnapshot: 'LEGACY NAME',
    classCodeSnapshot: classCode,
    rollNoSnapshot: 1,
    scores: { ...emptyScores(), ...scores },
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);
}

beforeEach(async () => {
  await seedSettings();
  app = createApp();
  adminHeader = (await adminAuth()).header;
});

describe('PUT /academics/marks — deriving the percentage', () => {
  it('saves subject marks and derives the percentage from them', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    // Every one of class 5's six subjects, 17 out of 20 -> 102/120.
    await saveMarks(adminHeader, studentId!, { UT1: everySubject('5', 17) }).expect(200);

    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(stored?.scores.UT1).toBe(85);
    expect(stored?.subjectMarks?.UT1?.ENGLISH).toBe(17);
    expect(stored?.scores.UT2).toBeNull();

    const res = await request(app)
      .get('/api/v1/academics')
      .query({ academicYear: YEAR, classCode: '5' })
      .set('Authorization', adminHeader)
      .expect(200);

    expect(res.body.items[0]).toMatchObject({
      studentId,
      fullName: 'AARAV SHARMA',
      classCode: '5',
      rollNo: 1,
      hasRecord: true,
    });
    expect(res.body.items[0].scores.UT1).toBe(85);
    expect(res.body.items[0].subjectMarks.UT1.MATHS).toBe(17);
  });

  it('counts only the subjects that were marked, not the whole class list', async () => {
    const [studentId] = await seedClass('1', ['Aarav Sharma']);

    // Two of class 1's six subjects: 34 out of 40, not 34 out of 120.
    await saveMarks(adminHeader, studentId!, { UT1: { ENGLISH: 18, HINDI: 16 } }).expect(200);

    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(stored?.scores.UT1).toBe(85);
  });

  it('leaves a paper nobody has marked at null rather than zero', async () => {
    const [studentId] = await seedClass('1', ['Aarav Sharma']);

    await saveMarks(adminHeader, studentId!, { UT1: { ENGLISH: 18 } }).expect(200);

    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(stored?.scores.UT1).toBe(90);
    expect(stored?.scores.FINAL).toBeNull();
  });

  it('treats 0 as a real mark, counted in both halves of the fraction', async () => {
    const [studentId] = await seedClass('1', ['Aarav Sharma']);

    await saveMarks(adminHeader, studentId!, { UT1: { ENGLISH: 0, HINDI: 0 } }).expect(200);

    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(stored?.scores.UT1).toBe(0);
    expect(stored?.scores.UT2).toBeNull();
  });

  it('divides by the paper maximum, so the same marks differ between a UT and a final', async () => {
    const [studentId] = await seedClass('1', ['Aarav Sharma']);

    await saveMarks(adminHeader, studentId!, {
      UT1: { ENGLISH: 16, HINDI: 16 },
      FINAL: { ENGLISH: 16, HINDI: 16 },
    }).expect(200);

    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(stored?.scores.UT1).toBe(80); // 32 of 40
    expect(stored?.scores.FINAL).toBe(20); // 32 of 160
  });

  it('overwrites on re-save, so correcting a mark needs no special case', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    await saveMarks(adminHeader, studentId!, { UT1: everySubject('5', 8) }).expect(200);
    await saveMarks(adminHeader, studentId!, { UT1: everySubject('5', 18) }).expect(200);

    expect(await ExamResult.countDocuments()).toBe(1);
    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(stored?.scores.UT1).toBe(90);
  });

  it('clears the percentage when every subject on a paper is deleted', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    await saveMarks(adminHeader, studentId!, { UT1: everySubject('5', 18) }).expect(200);
    await saveMarks(adminHeader, studentId!, {}).expect(200);

    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(stored?.scores.UT1).toBeNull();
    expect(stored?.subjectMarks?.UT1?.ENGLISH).toBeNull();
  });
});

describe('PUT /academics/marks — validation', () => {
  it('rejects a fractional mark rather than rounding it', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    const res = await saveMarks(adminHeader, studentId!, { UT1: { ENGLISH: 17.5 } }).expect(400);
    expect(res.body.error.message).toMatch(/correct the highlighted fields/i);
    expect(res.body.error.details).toContainEqual(
      expect.objectContaining({
        field: 'subjectMarks.UT1.ENGLISH',
        message: expect.stringMatching(/whole number/i),
      }),
    );
    expect(await ExamResult.countDocuments()).toBe(0);
  });

  it('rejects a mark above what that paper is out of', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    const ut = await saveMarks(adminHeader, studentId!, { UT1: { ENGLISH: 21 } }).expect(400);
    expect(ut.body.error.details).toContainEqual(
      expect.objectContaining({
        field: 'subjectMarks.UT1.ENGLISH',
        message: expect.stringMatching(/out of 20/i),
      }),
    );

    const final = await saveMarks(adminHeader, studentId!, { FINAL: { ENGLISH: 81 } }).expect(400);
    expect(final.body.error.details).toContainEqual(
      expect.objectContaining({ message: expect.stringMatching(/out of 80/i) }),
    );

    // 80 in a half-yearly is the maximum, not an overflow.
    await saveMarks(adminHeader, studentId!, { HALF_YEARLY: { ENGLISH: 80 } }).expect(200);
  });

  it('rejects a negative mark', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    await saveMarks(adminHeader, studentId!, { UT1: { ENGLISH: -1 } }).expect(400);
    expect(await ExamResult.countDocuments()).toBe(0);
  });

  it('rejects a subject the class is not taught', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    const res = await saveMarks(adminHeader, studentId!, { UT1: { SCIENCE: 18 } }).expect(400);
    expect(res.body.error.details).toContainEqual(
      expect.objectContaining({
        field: 'subjectMarks.UT1.SCIENCE',
        message: expect.stringMatching(/science is not taught in class 5/i),
      }),
    );
    expect(await ExamResult.countDocuments()).toBe(0);
  });

  it('accepts nulls for subjects the class is not taught, which every save carries', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    // card() fills SCIENCE and SST with null for a class that sits neither. If a null read
    // as "a subject this class does not have", every single save in the app would 400.
    await saveMarks(adminHeader, studentId!, { UT1: { ENGLISH: 18, SCIENCE: null } }).expect(200);
    expect(await ExamResult.countDocuments()).toBe(1);
  });

  it('refuses a subject code containing a dot, so the label never becomes the code', async () => {
    const [studentId] = await seedClass('6', ['Kabir Nair']);

    const res = await request(app)
      .put('/api/v1/academics/marks')
      .set('Authorization', adminHeader)
      .send({ studentId, academicYear: YEAR, subjectMarks: { UT1: { 'S.St': 18 } } })
      .expect(400);

    expect(res.body.error.message).toMatch(/invalid field name/i);
  });

  it('refuses to open a new card for a session that is not in progress', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    const res = await saveMarks(
      adminHeader,
      studentId!,
      { UT1: everySubject('5', 14) },
      LAST_YEAR,
    ).expect(400);
    expect(res.body.error.message).toMatch(/session in progress/i);
    expect(await ExamResult.countDocuments()).toBe(0);
  });

  it('records both the marks and the derived percentages in the audit log', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: everySubject('5', 14) }).expect(200);

    const entry = await AuditLog.findOne({ action: 'academics.save' }).lean();
    expect(entry?.after).toMatchObject({ classCode: '5' });
    expect((entry?.after as { scores: ExamScores }).scores.UT1).toBe(70);
    expect((entry?.after as { subjectMarks: { UT1: Paper } }).subjectMarks.UT1.ENGLISH).toBe(14);
    expect(entry?.after).toHaveProperty('subjectGrades');
  });

  it('404s for a student that does not exist', async () => {
    await saveMarks(adminHeader, 'RNTPS-26-999', { UT1: { ENGLISH: 14 } }).expect(404);
  });
});

describe('PUT /academics/marks — records predating subject-wise entry', () => {
  it('keeps the old percentage when the save touches a different paper', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await seedLegacyRecord(studentId!, '5', { HALF_YEARLY: 78.5 });

    await saveMarks(adminHeader, studentId!, { UT1: everySubject('5', 14) }).expect(200);

    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(stored?.scores.HALF_YEARLY).toBe(78.5);
    expect(stored?.scores.UT1).toBe(70);
  });

  it('replaces the old percentage once that paper has subject marks', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await seedLegacyRecord(studentId!, '5', { HALF_YEARLY: 78.5 });

    await saveMarks(adminHeader, studentId!, { HALF_YEARLY: everySubject('5', 40) }).expect(200);

    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(stored?.scores.HALF_YEARLY).toBe(50);
  });

  it('leaves an untouched old percentage alone on every later save', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await seedLegacyRecord(studentId!, '5', { FINAL: 91.25 });

    await saveMarks(adminHeader, studentId!, { UT1: everySubject('5', 10) }).expect(200);
    await saveMarks(adminHeader, studentId!, { UT2: everySubject('5', 12) }).expect(200);

    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(stored?.scores.FINAL).toBe(91.25);
  });
});

describe('PUT /academics/marks — graded subjects', () => {
  it('saves a grade and reads it back', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    await saveMarks(
      adminHeader,
      studentId!,
      {},
      YEAR,
      { UT1: { DRAWING: 'A+', DISCIPLINE: 'B', NEATNESS: 'A' } },
    ).expect(200);

    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(stored?.subjectGrades?.UT1?.DRAWING).toBe('A+');
    expect(stored?.subjectGrades?.UT1?.DISCIPLINE).toBe('B');
    expect(stored?.subjectGrades?.UT2?.DRAWING).toBeNull();
  });

  it('keeps a grade out of the total and the percentage', async () => {
    const [studentId] = await seedClass('1', ['Aarav Sharma']);

    await saveMarks(
      adminHeader,
      studentId!,
      { UT1: { ENGLISH: 18, HINDI: 16 } },
      YEAR,
      { UT1: { DRAWING: 'A+', DISCIPLINE: 'C', NEATNESS: 'B' } },
    ).expect(200);

    // 34 of 40 — the three grades neither add to the numerator nor widen the denominator.
    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(stored?.scores.UT1).toBe(85);
  });

  it('leaves the percentage null on a paper that is only graded', async () => {
    const [studentId] = await seedClass('1', ['Aarav Sharma']);

    await saveMarks(adminHeader, studentId!, {}, YEAR, { FINAL: { DRAWING: 'A' } }).expect(200);

    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(stored?.scores.FINAL).toBeNull();
    expect(stored?.subjectGrades?.FINAL?.DRAWING).toBe('A');
  });

  it('grades every class, including one with only three marked subjects', async () => {
    const [studentId] = await seedClass('NURSERY', ['Aarav Sharma']);

    await saveMarks(adminHeader, studentId!, {}, YEAR, { UT1: { NEATNESS: 'A' } }).expect(200);

    const res = await request(app)
      .get('/api/v1/academics')
      .query({ classCode: 'NURSERY' })
      .set('Authorization', adminHeader)
      .expect(200);
    expect(res.body.items[0].subjectGrades.UT1.NEATNESS).toBe('A');
  });

  it('trims and upper-cases a grade, and treats blank as not graded', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    await saveMarks(
      adminHeader,
      studentId!,
      {},
      YEAR,
      { UT1: { DRAWING: '  a+  ', DISCIPLINE: '' } },
    ).expect(200);

    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    // The box renders uppercase, so storing what was typed would make "a" and "A" two
    // different grades that look the same everywhere.
    expect(stored?.subjectGrades?.UT1?.DRAWING).toBe('A+');
    expect(stored?.subjectGrades?.UT1?.DISCIPLINE).toBeNull();
  });

  it('rejects a grade longer than a grade', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    const res = await saveMarks(adminHeader, studentId!, {}, YEAR, {
      UT1: { DRAWING: 'outstanding effort' },
    }).expect(400);

    expect(res.body.error.details).toContainEqual(
      expect.objectContaining({
        field: 'subjectGrades.UT1.DRAWING',
        message: expect.stringMatching(/at most 10 characters/i),
      }),
    );
    expect(await ExamResult.countDocuments()).toBe(0);
  });

  it('clears a grade on re-save, so a wrong one can be taken back', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    await saveMarks(adminHeader, studentId!, {}, YEAR, { UT1: { DRAWING: 'A' } }).expect(200);
    await saveMarks(adminHeader, studentId!, {}, YEAR, {}).expect(200);

    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(stored?.subjectGrades?.UT1?.DRAWING).toBeNull();
  });
});

describe('POST /academics/marks/:studentId/:academicYear/move-class', () => {
  function moveClass(header: string, studentId: string, academicYear = YEAR) {
    return request(app)
      .post(`/api/v1/academics/marks/${studentId}/${academicYear}/move-class`)
      .set('Authorization', header);
  }

  /** A class-1 card, then the student moved to class 6 on the register. */
  async function seedMovedStudent() {
    const [studentId] = await seedClass('1', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, {
      UT1: { ENGLISH: 18, HINDI: 16, MATHS: 19, EVS: 20, GK: 15, COMPUTER: 12 },
    }).expect(200);
    await Student.updateOne({ _id: studentId }, { $set: { classCode: '6', rollNo: 9 } });
    return studentId!;
  }

  it('refiles the card under the class the student is now in', async () => {
    const studentId = await seedMovedStudent();

    const res = await moveClass(adminHeader, studentId).expect(200);
    expect(res.body).toMatchObject({ classCode: '6', rollNo: 9, currentClassCode: null });

    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(stored?.classCodeSnapshot).toBe('6');
    expect(stored?.rollNoSnapshot).toBe(9);
  });

  it('recomputes the percentage without the subjects the new class does not sit', async () => {
    const studentId = await seedMovedStudent();

    // 100 of 120 as class 1; EVS is not a class-6 subject, so 80 of 100 once refiled.
    const before = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(before?.scores.UT1).toBe(83.33);

    await moveClass(adminHeader, studentId).expect(200);

    const after = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(after?.scores.UT1).toBe(80);
    // The mark itself is kept, so moving the card back restores the old figure.
    expect(after?.subjectMarks?.UT1?.EVS).toBe(20);
  });

  it('blanks a paper marked only in a subject the new class drops', async () => {
    const [studentId] = await seedClass('1', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: { EVS: 20 } }).expect(200);
    await Student.updateOne({ _id: studentId }, { $set: { classCode: '6' } });

    await moveClass(adminHeader, studentId!).expect(200);

    // Persisting the null matters: left at 100, the next ordinary save would read the
    // paper as one predating subject-wise entry and carry the stale figure forward.
    const stored = await ExamResult.findById(`${studentId}:${YEAR}`).lean();
    expect(stored?.scores.UT1).toBeNull();

    await saveMarks(adminHeader, studentId!, {}).expect(200);
    expect((await ExamResult.findById(`${studentId}:${YEAR}`).lean())?.scores.UT1).toBeNull();
  });

  it('records the class it was moved from, which the snapshot no longer remembers', async () => {
    const studentId = await seedMovedStudent();
    await moveClass(adminHeader, studentId).expect(200);

    const entry = await AuditLog.findOne({ action: 'academics.move-class' }).lean();
    expect(entry?.before).toMatchObject({ classCode: '1' });
    expect(entry?.after).toMatchObject({ classCode: '6', rollNo: 9 });
  });

  it('refuses a closed session, whose marks belong to the class they were sat in', async () => {
    const studentId = await seedMovedStudent();
    await Settings.updateOne({ _id: SETTINGS_ID }, { $set: { activeAcademicYear: '2027-28' } });

    const res = await moveClass(adminHeader, studentId).expect(400);
    expect(res.body.error.message).toMatch(/session in progress/i);
    expect((await ExamResult.findById(`${studentId}:${YEAR}`).lean())?.classCodeSnapshot).toBe('1');
  });

  it('refuses when the card already matches the register', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: everySubject('5', 17) }).expect(200);

    const res = await moveClass(adminHeader, studentId!).expect(400);
    expect(res.body.error.message).toMatch(/already filed under Class 5/i);
  });

  it('refuses when there is no card to move', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await moveClass(adminHeader, studentId!).expect(400);
  });

  it('is refused to a teacher, even for their own class', async () => {
    const studentId = await seedMovedStudent();
    const { header } = await teacherAuth(['1']);

    await moveClass(header, studentId).expect(403);
    expect((await ExamResult.findById(`${studentId}:${YEAR}`).lean())?.classCodeSnapshot).toBe('1');
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
    expect(res.body.items[0].scores).toEqual(emptyScores());
    expect(res.body.items[0].subjectMarks).toEqual(emptySubjectMarks());
    expect(res.body.items[0].subjectGrades).toEqual(emptySubjectGrades());
  });

  it('defaults to the session in progress', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: everySubject('5', 11) }).expect(200);

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
    expect(res.body.items[0].fullName).toBe('DIYA VERMA');
  });

  it('sorts unmarked students last in both directions', async () => {
    const [low, high, unmarked] = await seedClass('5', ['Aarav Sharma', 'Diya Verma', 'Kabir Nair']);
    await saveMarks(adminHeader, low!, { UT1: everySubject('5', 8) }).expect(200);
    await saveMarks(adminHeader, high!, { UT1: everySubject('5', 18) }).expect(200);

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
    await saveMarks(adminHeader, studentId!, { UT1: everySubject('5', 16) }).expect(200);

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
    expect(closed.body.items[0].scores.UT1).toBe(80);
    // The archived card carries its marks too — the student's report card renders from them.
    expect(closed.body.items[0].subjectMarks.UT1.EVS).toBe(16);

    const current = await request(app).get('/api/v1/academics').set('Authorization', adminHeader).expect(200);
    expect(current.body.items[0]).toMatchObject({ classCode: '6', rollNo: null, hasRecord: false });
  });

  it('flags a card filed under a class the student has since left', async () => {
    const [studentId] = await seedClass('1', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: { ENGLISH: 18 } }).expect(200);
    await Student.updateOne({ _id: studentId }, { $set: { classCode: '6' } });

    const res = await request(app).get('/api/v1/academics').set('Authorization', adminHeader).expect(200);
    expect(res.body.items[0]).toMatchObject({ classCode: '1', currentClassCode: '6' });
  });

  it('does not flag a closed session, where the live class differing is the whole point', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: everySubject('5', 16) }).expect(200);
    await Student.updateOne(
      { _id: studentId },
      { $set: { classCode: '6', academicYear: '2027-28', rollNo: null } },
    );
    await Settings.updateOne({ _id: SETTINGS_ID }, { $set: { activeAcademicYear: '2027-28' } });

    const res = await request(app)
      .get('/api/v1/academics')
      .query({ academicYear: YEAR })
      .set('Authorization', adminHeader)
      .expect(200);
    expect(res.body.items[0]).toMatchObject({ classCode: '5', currentClassCode: null });
  });

  it('shows the current name but the session\'s class for an archived row', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: everySubject('5', 16) }).expect(200);
    await Student.updateOne({ _id: studentId }, { $set: { fullName: 'Aarav Sharma-Verma' } });

    const res = await request(app).get('/api/v1/academics').set('Authorization', adminHeader).expect(200);
    expect(res.body.items[0].fullName).toBe('Aarav Sharma-Verma');
  });

  it('marks a closed session against the class it was sat in, not the one since promoted to', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: everySubject('5', 16) }).expect(200);

    await Student.updateOne(
      { _id: studentId },
      { $set: { classCode: '6', academicYear: '2027-28', rollNo: null } },
    );
    await Settings.updateOne({ _id: SETTINGS_ID }, { $set: { activeAcademicYear: '2027-28' } });

    // The snapshot says class 5, so EVS is still correctable and Science is still refused —
    // the promotion must not retitle last year's papers.
    await saveMarks(adminHeader, studentId!, { UT1: { EVS: 19 } }, YEAR).expect(200);
    await saveMarks(adminHeader, studentId!, { UT1: { SCIENCE: 19 } }, YEAR).expect(400);
  });
});

describe('GET /academics/years', () => {
  it('offers the session in progress even with nothing recorded', async () => {
    const res = await request(app).get('/api/v1/academics/years').set('Authorization', adminHeader).expect(200);
    expect(res.body).toEqual({ years: [YEAR], activeAcademicYear: YEAR });
  });

  it('adds every session with marks on record, newest first', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: everySubject('5', 14) }).expect(200);
    await Settings.updateOne({ _id: SETTINGS_ID }, { $set: { activeAcademicYear: '2027-28' } });

    const res = await request(app).get('/api/v1/academics/years').set('Authorization', adminHeader).expect(200);
    expect(res.body.years).toEqual(['2027-28', YEAR]);
  });
});

describe('GET /academics/student/:studentId', () => {
  it('returns every session on record, newest first', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: everySubject('5', 14) }).expect(200);

    await Settings.updateOne({ _id: SETTINGS_ID }, { $set: { activeAcademicYear: '2027-28' } });
    await Student.updateOne({ _id: studentId }, { $set: { classCode: '6', academicYear: '2027-28' } });
    await saveMarks(adminHeader, studentId!, { UT1: everySubject('6', 16) }, '2027-28').expect(200);

    const res = await request(app)
      .get(`/api/v1/academics/student/${studentId}`)
      .set('Authorization', adminHeader)
      .expect(200);

    expect(res.body.years.map((y: { academicYear: string }) => y.academicYear)).toEqual(['2027-28', YEAR]);
    expect(res.body.years[0]).toMatchObject({ classCode: '6' });
    expect(res.body.years[1]).toMatchObject({ classCode: '5' });
    // Class 6 sits S.St; class 5 does not, so the same card shape reads differently per year.
    expect(res.body.years[0].subjectMarks.UT1.SST).toBe(16);
    expect(res.body.years[1].subjectMarks.UT1.SST).toBeNull();
  });

  it('returns an empty history for a student with no marks', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    const res = await request(app)
      .get(`/api/v1/academics/student/${studentId}`)
      .set('Authorization', adminHeader)
      .expect(200);

    expect(res.body.years).toEqual([]);
    expect(res.body.fullName).toBe('AARAV SHARMA');
  });

  it('404s for a student that does not exist', async () => {
    await request(app)
      .get('/api/v1/academics/student/RNTPS-26-999')
      .set('Authorization', adminHeader)
      .expect(404);
  });
});

describe('GET /academics/report-card/:studentId/:academicYear/whatsapp-link', () => {
  it('builds a link to the reachable guardian carrying the card', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: everySubject('5', 17) }, YEAR, {
      UT1: { DRAWING: 'A+' },
    }).expect(200);

    const res = await request(app)
      .get(`/api/v1/academics/report-card/${studentId}/${YEAR}/whatsapp-link`)
      .set('Authorization', adminHeader)
      .expect(200);

    expect(res.body.waLink).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
    expect(res.body.guardianPhone).toMatch(/^91\d{10}$/);
    expect(res.body.compact).toBe(false);

    const message = decodeURIComponent(res.body.waLink.split('?text=')[1]);
    expect(message).toContain('AARAV SHARMA');
    expect(message).toContain('Class 5');
    expect(message).toContain('UT-1');
    expect(message).toContain('17/20');
    expect(message).toContain('85.00%');
    // A grade is reported but never rolled into the total beside it.
    expect(message).toContain('A+');
    expect(message).toContain('102/120');
  });

  it('drops the subject breakdown rather than the tail when the card is too long', async () => {
    const [studentId] = await seedClass('8', ['Kabir Nair']);
    const exams: ExamCode[] = ['UT1', 'UT2', 'HALF_YEARLY', 'UT3', 'UT4', 'FINAL'];
    const everyPaper = Object.fromEntries(
      exams.map((exam) => [exam, everySubject('8', exam.startsWith('UT') ? 17 : 68)]),
    );
    const everyGrade = Object.fromEntries(
      exams.map((exam) => [exam, { DRAWING: 'A+', DISCIPLINE: 'A+', NEATNESS: 'A+' }]),
    );
    // The genuine worst case: class 8 sits seven subjects, and all six papers are marked
    // and graded. Without grades this card comes to 3803 URL characters — 197 short of the
    // ceiling — so it is the three grade rows per paper that actually tip it over.
    await saveMarks(adminHeader, studentId!, everyPaper, YEAR, everyGrade).expect(200);

    const res = await request(app)
      .get(`/api/v1/academics/report-card/${studentId}/${YEAR}/whatsapp-link`)
      .set('Authorization', adminHeader)
      .expect(200);

    expect(res.body.compact).toBe(true);
    expect(res.body.waLink.length).toBeLessThanOrEqual(4000);
    // The final exam is the last thing in the message and the thing a parent most wants.
    expect(decodeURIComponent(res.body.waLink)).toContain('Final');
  });

  it('narrows the card to one paper when asked', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await saveMarks(
      adminHeader,
      studentId!,
      { UT1: everySubject('5', 17), FINAL: everySubject('5', 60) },
      YEAR,
      { UT1: { DRAWING: 'A+' } },
    ).expect(200);

    const res = await request(app)
      .get(`/api/v1/academics/report-card/${studentId}/${YEAR}/whatsapp-link`)
      .query({ exam: 'UT1' })
      .set('Authorization', adminHeader)
      .expect(200);

    const message = decodeURIComponent(res.body.waLink.split('?text=')[1]);
    expect(message).toContain('UT-1 Report Card');
    expect(message).toContain('102/120');
    expect(message).toContain('A+');
    // The final is on the same card but out of scope, so none of it may leak in.
    expect(message).not.toContain('Final');
    expect(message).not.toContain('360/480');
  });

  it('refuses a paper with nothing on it', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: everySubject('5', 17) }).expect(200);

    const res = await request(app)
      .get(`/api/v1/academics/report-card/${studentId}/${YEAR}/whatsapp-link`)
      .query({ exam: 'UT3' })
      .set('Authorization', adminHeader)
      .expect(400);
    expect(res.body.error.message).toMatch(/nothing is recorded for UT3/i);
  });

  it('rejects an exam code that is not one of the six', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: everySubject('5', 17) }).expect(200);

    await request(app)
      .get(`/api/v1/academics/report-card/${studentId}/${YEAR}/whatsapp-link`)
      .query({ exam: 'UT9' })
      .set('Authorization', adminHeader)
      .expect(400);
  });

  it('refuses when there are no marks on record for that session', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);

    const res = await request(app)
      .get(`/api/v1/academics/report-card/${studentId}/${YEAR}/whatsapp-link`)
      .set('Authorization', adminHeader)
      .expect(400);
    expect(res.body.error.message).toMatch(/no marks are on record/i);
  });

  it('refuses when every guardian has opted out of WhatsApp', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    await saveMarks(adminHeader, studentId!, { UT1: everySubject('5', 17) }).expect(200);
    await Student.updateOne(
      { _id: studentId },
      { $set: { 'guardians.$[].whatsappOptOut': true } },
    );

    const res = await request(app)
      .get(`/api/v1/academics/report-card/${studentId}/${YEAR}/whatsapp-link`)
      .set('Authorization', adminHeader)
      .expect(400);
    expect(res.body.error.message).toMatch(/opted out of whatsapp/i);
  });

  it('confines a teacher to their own classes, on the snapshot not the request', async () => {
    const [outsider] = await seedClass('6', ['Kabir Nair']);
    await saveMarks(adminHeader, outsider!, { UT1: everySubject('6', 15) }).expect(200);
    const { header } = await teacherAuth(['5']);

    // Reading a record is an internal act and stays open; sending a parent a message is not.
    const res = await request(app)
      .get(`/api/v1/academics/report-card/${outsider}/${YEAR}/whatsapp-link`)
      .set('Authorization', header)
      .expect(403);
    expect(res.body.error.message).toMatch(/not assigned to 6/i);
  });

  it('requires a signed-in user', async () => {
    await request(app).get(`/api/v1/academics/report-card/RNTPS-26-001/${YEAR}/whatsapp-link`).expect(401);
  });
});

describe('authorisation', () => {
  it('lets a teacher save marks for their own class', async () => {
    const [studentId] = await seedClass('5', ['Aarav Sharma']);
    const { header } = await teacherAuth(['5']);

    await saveMarks(header, studentId!, { UT1: everySubject('5', 15) }).expect(200);
  });

  it('refuses a teacher saving marks for another class', async () => {
    const [outsider] = await seedClass('6', ['Kabir Nair']);
    const { header } = await teacherAuth(['5']);

    const res = await saveMarks(header, outsider!, { UT1: everySubject('6', 15) }).expect(403);
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
      .send({
        studentId: outsider,
        academicYear: YEAR,
        classCode: '5',
        subjectMarks: card({ UT1: everySubject('6', 15) }),
        subjectGrades: gradeCard({}),
      })
      .expect(403);
  });

  it('requires a signed-in user', async () => {
    await request(app).get('/api/v1/academics').expect(401);
    await request(app).get('/api/v1/academics/years').expect(401);
    await request(app).put('/api/v1/academics/marks').send({}).expect(401);
  });
});
