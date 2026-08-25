import { academicYearFor, toDateKey } from '@rntps/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { Student } from '../../models/Student.js';
import { SETTINGS_ID, Settings } from '../../models/Settings.js';
import { listQuery, seedSettings, studentInput } from '../../test/factories.js';
import * as service from './student.service.js';

beforeEach(async () => {
  await seedSettings();
});

describe('createStudent', () => {
  it('generates a sequential, prefixed studentId as the primary key', async () => {
    const first = await service.createStudent(studentInput());
    const second = await service.createStudent(studentInput({ fullName: 'Diya Verma' }));

    expect(first.studentId).toBe('RNTPS-26-001');
    expect(second.studentId).toBe('RNTPS-26-002');

    // The generated id really is the _id, not a secondary field.
    expect(await Student.findById('RNTPS-26-001')).not.toBeNull();
  });

  it('normalises a 10-digit guardian phone to the wa.me form', async () => {
    const student = await service.createStudent(studentInput());
    expect(student.guardians[0]?.phone).toBe('919876543210');
  });

  it('accepts an admin-supplied studentId so existing admission numbers survive', async () => {
    const student = await service.createStudent(studentInput({ studentId: 'old-114' }));
    expect(student.studentId).toBe('OLD-114');
  });

  it('rejects a duplicate admin-supplied studentId', async () => {
    await service.createStudent(studentInput({ studentId: 'OLD-114' }));
    await expect(service.createStudent(studentInput({ studentId: 'OLD-114' }))).rejects.toThrow(
      /already in use/i,
    );
  });

  it('hands out unique ids when students are onboarded concurrently', async () => {
    const created = await Promise.all(
      Array.from({ length: 10 }, (_, i) => service.createStudent(studentInput({ fullName: `Student ${i}` }))),
    );
    const ids = new Set(created.map((s) => s.studentId));
    expect(ids.size).toBe(10);
  });

  it('stamps the active academic year from settings', async () => {
    const student = await service.createStudent(studentInput());
    expect(student.academicYear).toBe(academicYearFor(new Date('2026-08-25T00:00:00Z')));
  });
});

describe('siblings via familyId', () => {
  it('gives unrelated students different familyIds', async () => {
    const a = await service.createStudent(studentInput());
    const b = await service.createStudent(studentInput({ fullName: 'Kabir Singh' }));
    expect(a.familyId).not.toBe(b.familyId);
  });

  it('makes a linked sibling inherit the existing familyId', async () => {
    const elder = await service.createStudent(studentInput());
    const younger = await service.createStudent(
      studentInput({ fullName: 'Ananya Sharma', classCode: '2', siblingOfStudentId: elder.studentId }),
    );

    expect(younger.familyId).toBe(elder.familyId);
  });

  it('shows the link from both sides', async () => {
    const elder = await service.createStudent(studentInput());
    const younger = await service.createStudent(
      studentInput({ fullName: 'Ananya Sharma', classCode: '2', siblingOfStudentId: elder.studentId }),
    );

    const elderSiblings = await service.getSiblings(elder.studentId);
    const youngerSiblings = await service.getSiblings(younger.studentId);

    expect(elderSiblings.map((s) => s.studentId)).toEqual([younger.studentId]);
    expect(youngerSiblings.map((s) => s.studentId)).toEqual([elder.studentId]);
  });

  it('links a third child into the same family', async () => {
    const first = await service.createStudent(studentInput());
    const second = await service.createStudent(
      studentInput({ fullName: 'Bhavna Sharma', classCode: '3', siblingOfStudentId: first.studentId }),
    );
    // Linking against the *second* child must land in the same family, not a new one.
    const third = await service.createStudent(
      studentInput({ fullName: 'Chirag Sharma', classCode: '1', siblingOfStudentId: second.studentId }),
    );

    expect(new Set([first.familyId, second.familyId, third.familyId]).size).toBe(1);
    expect(await service.getSiblings(first.studentId)).toHaveLength(2);
  });

  it('rejects a sibling link to an unknown student', async () => {
    await expect(
      service.createStudent(studentInput({ siblingOfStudentId: 'RNTPS-26-999' })),
    ).rejects.toThrow(/to link as a sibling/i);
  });

  it('returns guardian and address defaults for pre-filling the sibling form', async () => {
    const elder = await service.createStudent(
      studentInput({ address: { line1: '12 Gandhi Road', city: 'Patna', state: 'Bihar', pincode: '800001' } }),
    );

    const defaults = await service.getFamilyDefaults(elder.studentId);
    expect(defaults.familyId).toBe(elder.familyId);
    expect(defaults.guardians[0]?.phone).toBe('919876543210');
    expect(defaults.address.city).toBe('Patna');
  });
});

describe('listStudents', () => {
  beforeEach(async () => {
    await service.createStudent(studentInput({ fullName: 'Aarav Sharma', classCode: '5' }));
    await service.createStudent(studentInput({ fullName: 'Diya Verma', classCode: '5' }));
    await service.createStudent(studentInput({ fullName: 'Kabir Singh', classCode: 'NURSERY' }));
  });

  it('filters by class', async () => {
    const page = await service.listStudents(listQuery({ classCode: '5' }));
    expect(page.total).toBe(2);
  });

  it('searches by name and by studentId', async () => {
    const byName = await service.listStudents(listQuery({ q: 'diya' }));
    expect(byName.items[0]?.fullName).toBe('Diya Verma');

    const byId = await service.listStudents(listQuery({ q: 'RNTPS-26-003' }));
    expect(byId.items[0]?.fullName).toBe('Kabir Singh');
  });

  it('treats regex metacharacters in the search term literally', async () => {
    const page = await service.listStudents(listQuery({ q: '.*' }));
    expect(page.total).toBe(0);
  });

  it('paginates', async () => {
    const page = await service.listStudents(listQuery({ page: 2, limit: 2 }));
    expect(page.items).toHaveLength(1);
    expect(page.totalPages).toBe(2);
  });
});

describe('status changes', () => {
  it('frees the roll number and records the reason without deleting the record', async () => {
    const student = await service.createStudent(studentInput({ rollNo: 12 }));
    const updated = await service.setStudentStatus(student.studentId, 'TC_ISSUED', 'Moved city');

    expect(updated.status).toBe('TC_ISSUED');
    expect(updated.rollNo).toBeNull();
    expect(updated.notes).toContain('Moved city');
    expect(await Student.countDocuments()).toBe(1);
  });
});

describe('roll numbers', () => {
  it('rejects a duplicate roll number within the same active class', async () => {
    await service.createStudent(studentInput({ rollNo: 7, classCode: '5' }));
    await expect(
      service.createStudent(studentInput({ fullName: 'Other', rollNo: 7, classCode: '5' })),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('allows the same roll number in a different class', async () => {
    await service.createStudent(studentInput({ rollNo: 7, classCode: '5' }));
    const other = await service.createStudent(studentInput({ fullName: 'Other', rollNo: 7, classCode: '6' }));
    expect(other.rollNo).toBe(7);
  });
});

describe('promoteStudents', () => {
  const years = { fromAcademicYear: '2026-27', toAcademicYear: '2027-28' };

  beforeEach(async () => {
    await Settings.updateOne({ _id: SETTINGS_ID }, { $set: { activeAcademicYear: '2026-27' } });
    await service.createStudent(studentInput({ fullName: 'Nursery Kid', classCode: 'NURSERY' }));
    await service.createStudent(studentInput({ fullName: 'UKG Kid', classCode: 'UKG' }));
    await service.createStudent(studentInput({ fullName: 'Class 8 Kid', classCode: '8' }));
  });

  it('previews without writing when dryRun is set', async () => {
    const result = await service.promoteStudents({ ...years, dryRun: true });

    expect(result.promoted).toHaveLength(2);
    expect(result.graduated).toHaveLength(1);
    const unchanged = await Student.findOne({ fullName: 'Nursery Kid' }).lean();
    expect(unchanged?.classCode).toBe('NURSERY');
  });

  it('moves each class up one step and graduates class 8', async () => {
    await service.promoteStudents({ ...years, dryRun: false });

    const nursery = await Student.findOne({ fullName: 'Nursery Kid' }).lean();
    const ukg = await Student.findOne({ fullName: 'UKG Kid' }).lean();
    const eighth = await Student.findOne({ fullName: 'Class 8 Kid' }).lean();

    expect(nursery?.classCode).toBe('LKG');
    expect(ukg?.classCode).toBe('1');
    expect(eighth?.status).toBe('ALUMNI');
    expect(nursery?.academicYear).toBe('2027-28');
  });

  it('is a no-op the second time, because the source year no longer matches', async () => {
    await service.promoteStudents({ ...years, dryRun: false });
    const second = await service.promoteStudents({ ...years, dryRun: false });

    expect(second.promoted).toHaveLength(0);
    const ukg = await Student.findOne({ fullName: 'UKG Kid' }).lean();
    expect(ukg?.classCode).toBe('1');
  });
});

describe('data-quality reports', () => {
  it('flags active students with no reachable WhatsApp guardian', async () => {
    await service.createStudent(studentInput({ fullName: 'Reachable' }));
    const optedOut = await service.createStudent(studentInput({ fullName: 'Opted Out' }));
    await Student.updateOne({ _id: optedOut.studentId }, { $set: { 'guardians.0.whatsappOptOut': true } });

    const flagged = await service.studentsWithoutWhatsapp();
    expect(flagged.map((s) => s.fullName)).toEqual(['Opted Out']);
  });

  it('counts active students per class', async () => {
    await service.createStudent(studentInput({ classCode: '5' }));
    await service.createStudent(studentInput({ fullName: 'Bhavna Roy', classCode: '5' }));
    await service.createStudent(studentInput({ fullName: 'Chirag Roy', classCode: 'LKG' }));

    const counts = await service.countByClass();
    expect(counts.find((c) => c.classCode === '5')?.count).toBe(2);
    expect(counts.find((c) => c.classCode === 'LKG')?.count).toBe(1);
  });
});

describe('IST date handling', () => {
  it('resolves a late-evening UTC instant to the next IST day', () => {
    // 2026-08-25T19:00Z is 2026-08-26 00:30 IST.
    expect(toDateKey(new Date('2026-08-25T19:00:00Z'))).toBe('2026-08-26');
  });

  it('keeps January dates in the previous academic session', () => {
    expect(academicYearFor(new Date('2027-01-15T06:00:00Z'))).toBe('2026-27');
    expect(academicYearFor(new Date('2026-04-01T06:00:00Z'))).toBe('2026-27');
    expect(academicYearFor(new Date('2026-03-31T06:00:00Z'))).toBe('2025-26');
  });
});
