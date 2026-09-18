import {
  MAX_SUBJECT_MARK,
  emptySubjectMarks,
  examTotal,
  hasAnySubjectMark,
  subjectMarksForClass,
  subjectsForClass,
  type SubjectCode,
} from '@rntps/shared';
import { describe, expect, it } from 'vitest';

/**
 * "A percentage counts only the subjects that were marked" is the rule this whole feature
 * turns on, and it lives in a pure function in `packages/shared`. Tested from here for the
 * same reason `concessionFor()` is tested from the fees module: shared has no runner.
 */

function paper(marks: Partial<Record<SubjectCode, number | null>>) {
  return { ...emptySubjectMarks().UT1, ...marks };
}

describe('examTotal — a percentage counts only the subjects that were marked', () => {
  it('divides by the papers that were marked, not by the whole class list', () => {
    // Class 1 sits six subjects; two of them are graded.
    expect(examTotal(paper({ ENGLISH: 18, HINDI: 16 }), '1', 'UT1')).toEqual({
      obtained: 34,
      max: 40,
      percent: 85,
    });
  });

  it('returns null — not a zero total — when nothing has been marked', () => {
    // saveExamResult branches on this being null to tell "not sat" from "scored nothing",
    // and a {obtained: 0, max: 0} object would be truthy and would break that silently.
    expect(examTotal(paper({}), '1', 'UT1')).toBeNull();
    expect(examTotal(undefined, '1', 'UT1')).toBeNull();
  });

  it('counts a zero, which is a mark, unlike a blank, which is not', () => {
    expect(examTotal(paper({ ENGLISH: 0, HINDI: 0 }), '1', 'UT1')).toEqual({
      obtained: 0,
      max: 40,
      percent: 0,
    });
  });

  it('is out of 20 a subject for a unit test and 80 for the big papers', () => {
    expect(MAX_SUBJECT_MARK.UT1).toBe(20);
    expect(MAX_SUBJECT_MARK.FINAL).toBe(80);

    const marks = paper({ ENGLISH: 16, HINDI: 16 });
    expect(examTotal(marks, '1', 'UT1')?.percent).toBe(80);
    expect(examTotal(marks, '1', 'FINAL')?.percent).toBe(20);
  });

  it('ignores a mark for a subject the class is not taught', () => {
    // Class 1 does not sit Science, so a stray mark cannot inflate the denominator.
    expect(examTotal(paper({ ENGLISH: 18, SCIENCE: 20 }), '1', 'UT1')).toEqual({
      obtained: 18,
      max: 20,
      percent: 90,
    });
  });

  it('returns nothing for a code that is not a class', () => {
    expect(examTotal(paper({ ENGLISH: 18 }), 'TEACHERS', 'UT1')).toBeNull();
  });

  it('rounds to two decimals, and the result survives a toFixed(2) round trip', () => {
    // 1 of 60 is 1.666…, which the stored-percentage rule caps at two decimals.
    const total = examTotal(paper({ ENGLISH: 1, HINDI: 0, MATHS: 0 }), '1', 'UT1');
    expect(total?.percent).toBe(1.67);
    expect(Number(total!.percent.toFixed(2))).toBe(total!.percent);
  });

  it('never exceeds 100, because a subject mark cannot exceed its paper', () => {
    const full = Object.fromEntries(subjectsForClass('8').map((s) => [s, 80]));
    expect(examTotal(paper(full), '8', 'FINAL')).toEqual({
      obtained: 560,
      max: 560,
      percent: 100,
    });
  });
});

describe('hasAnySubjectMark — what makes a paper subject-based', () => {
  it('is false for a blank paper and true once one subject is marked', () => {
    expect(hasAnySubjectMark(paper({}), '1')).toBe(false);
    expect(hasAnySubjectMark(paper({ ENGLISH: 0 }), '1')).toBe(true);
    expect(hasAnySubjectMark(undefined, '1')).toBe(false);
  });

  it('ignores marks for subjects outside the class list', () => {
    // Otherwise a leftover mark would strand the paper as subject-based with a null
    // percentage: it counts for nothing in the total but would block the old-record fallback.
    expect(hasAnySubjectMark(paper({ SCIENCE: 18 }), '1')).toBe(false);
  });
});

describe('subjectsForClass', () => {
  it('gives each band the subjects the school marks it on', () => {
    expect(subjectsForClass('NURSERY')).toEqual(['ENGLISH', 'HINDI', 'MATHS']);
    expect(subjectsForClass('LKG')).toEqual(['ENGLISH', 'HINDI', 'MATHS']);
    expect(subjectsForClass('UKG')).toEqual(['ENGLISH', 'HINDI', 'MATHS', 'GK']);
    expect(subjectsForClass('3')).toEqual(['ENGLISH', 'HINDI', 'MATHS', 'EVS', 'GK', 'COMPUTER']);
    expect(subjectsForClass('7')).toEqual([
      'ENGLISH',
      'HINDI',
      'MATHS',
      'SCIENCE',
      'GK',
      'COMPUTER',
      'SST',
    ]);
  });

  it('separates the primary and middle bands on EVS versus Science', () => {
    expect(subjectsForClass('5')).toContain('EVS');
    expect(subjectsForClass('5')).not.toContain('SCIENCE');
    expect(subjectsForClass('6')).toContain('SCIENCE');
    expect(subjectsForClass('6')).not.toContain('EVS');
  });

  it('gives nothing for a code that is not a class', () => {
    expect(subjectsForClass('TEACHERS')).toEqual([]);
  });
});

describe('subjectMarksForClass', () => {
  it('blanks marks for subjects the class does not sit', () => {
    const stored = emptySubjectMarks();
    stored.UT1.ENGLISH = 18;
    stored.UT1.SCIENCE = 19;

    // Seeds the edit form: react-hook-form posts back its defaults whether or not a field
    // was rendered, so a stale Science mark would be sent and rejected invisibly.
    const projected = subjectMarksForClass(stored, '1');
    expect(projected.UT1.ENGLISH).toBe(18);
    expect(projected.UT1.SCIENCE).toBeNull();
  });

  it('returns a blank card when there is nothing stored', () => {
    expect(subjectMarksForClass(undefined, '1')).toEqual(emptySubjectMarks());
  });
});
