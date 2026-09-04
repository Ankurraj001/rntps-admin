import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { AuditLog } from '../../models/AuditLog.js';
import { adminAuth, seedSettings, teacherAuth } from '../../test/factories.js';

let app: Express;
let adminHeader: string;

/** Every student route now requires a signed-in user; these default to an admin. */
const asAdmin = {
  get: (path: string) => request(app).get(path).set('Authorization', adminHeader),
  post: (path: string) => request(app).post(path).set('Authorization', adminHeader),
  patch: (path: string) => request(app).patch(path).set('Authorization', adminHeader),
};

const validBody = {
  fullName: 'Aarav Sharma',
  dob: '2015-06-14',
  gender: 'MALE',
  classCode: '5',
  admissionDate: '2026-04-01',
  guardians: [{ name: 'Rakesh Sharma', relation: 'FATHER', phone: '98765 43210', isPrimary: true }],
};

beforeEach(async () => {
  await seedSettings();
  app = createApp();
  adminHeader = (await adminAuth()).header;
});

describe('POST /api/v1/students', () => {
  it('onboards a student and returns 201 with the generated id', async () => {
    const res = await asAdmin.post('/api/v1/students').send(validBody).expect(201);

    expect(res.body.studentId).toBe('RNTPS-26-001');
    // A number typed with a space is accepted and normalised for wa.me.
    expect(res.body.guardians[0].phone).toBe('919876543210');
  });

  it('rejects a missing guardian with a field-level message', async () => {
    const res = await asAdmin.post('/api/v1/students')
      .send({ ...validBody, guardians: [] })
      .expect(400);

    expect(res.body.error.details).toContainEqual(
      expect.objectContaining({ field: 'guardians', message: expect.stringMatching(/at least one guardian/i) }),
    );
  });

  it('rejects a landline-shaped phone number', async () => {
    const res = await asAdmin.post('/api/v1/students')
      .send({ ...validBody, guardians: [{ ...validBody.guardians[0], phone: '0612 222333' }] })
      .expect(400);

    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects a date of birth after the admission date', async () => {
    await asAdmin.post('/api/v1/students')
      .send({ ...validBody, dob: '2027-01-01' })
      .expect(400);
  });

  it('requires exactly one primary guardian', async () => {
    await asAdmin.post('/api/v1/students')
      .send({
        ...validBody,
        guardians: [
          { name: 'Rakesh Sharma', relation: 'FATHER', phone: '9876543210', isPrimary: true },
          { name: 'Sunita Sharma', relation: 'MOTHER', phone: '9876543211', isPrimary: true },
        ],
      })
      .expect(400);
  });

  it('rejects an unknown class', async () => {
    await asAdmin.post('/api/v1/students').send({ ...validBody, classCode: '12' }).expect(400);
  });
});

describe('Mongo operator injection', () => {
  it('refuses a body containing an operator key', async () => {
    const res = await asAdmin.post('/api/v1/students')
      .send({ ...validBody, fullName: { $ne: null } })
      .expect(400);

    expect(res.body.error.message).toMatch(/invalid field name/i);
  });

  it('refuses an operator smuggled through the query string', async () => {
    await asAdmin.get('/api/v1/students').query({ 'status[$ne]': 'ACTIVE' }).expect(400);
  });
});

describe('GET /api/v1/students', () => {
  it('returns an empty, well-formed page when there are no students', async () => {
    const res = await asAdmin.get('/api/v1/students').expect(200);
    expect(res.body).toMatchObject({ items: [], total: 0, page: 1, totalPages: 1 });
  });

  it('caps the page size instead of allowing an unbounded query', async () => {
    await asAdmin.get('/api/v1/students').query({ limit: 5000 }).expect(400);
  });

  it('404s for an unknown student', async () => {
    const res = await asAdmin.get('/api/v1/students/RNTPS-26-999').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('sibling endpoints', () => {
  it('serves defaults that pre-fill the form for a second child', async () => {
    const elder = await asAdmin.post('/api/v1/students')
      .send({ ...validBody, address: { line1: '12 Gandhi Road', city: 'Patna' } })
      .expect(201);

    const defaults = await asAdmin.get(`/api/v1/students/${elder.body.studentId}/family-defaults`)
      .expect(200);
    expect(defaults.body.address.city).toBe('Patna');

    const younger = await asAdmin.post('/api/v1/students')
      .send({ ...validBody, fullName: 'Ananya Sharma', classCode: '2', siblingOfStudentId: elder.body.studentId })
      .expect(201);

    expect(younger.body.familyId).toBe(elder.body.familyId);

    const siblings = await asAdmin.get(`/api/v1/students/${elder.body.studentId}/siblings`)
      .expect(200);
    expect(siblings.body.items).toHaveLength(1);
  });

  it('requires at least two characters before searching', async () => {
    const res = await asAdmin.get('/api/v1/students/search-sibling').query({ q: 'a' }).expect(200);
    expect(res.body.items).toEqual([]);
  });
});

describe('health probes', () => {
  it('reports liveness', async () => {
    await asAdmin.get('/healthz').expect(200);
  });

  it('reports readiness once the database is connected', async () => {
    const res = await asAdmin.get('/readyz').expect(200);
    expect(res.body.database).toBe(true);
  });

  it('404s an unknown route with a structured error', async () => {
    const res = await asAdmin.get('/api/v1/nope').expect(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });
});

describe('optional text fields left blank', () => {
  it('auto-generates the id when the Student ID box is submitted empty', async () => {
    // An HTML text input posts "" rather than omitting the key; that must not be
    // treated as an attempt to set a malformed id.
    const res = await asAdmin.post('/api/v1/students')
      .send({ ...validBody, studentId: '', siblingOfStudentId: '' })
      .expect(201);

    expect(res.body.studentId).toBe('RNTPS-26-001');
  });

  it('still rejects a studentId that is present but malformed', async () => {
    await asAdmin.post('/api/v1/students').send({ ...validBody, studentId: 'a b' }).expect(400);
  });
});

describe('duplicate keys surface as friendly conflicts', () => {
  it('reports a duplicate roll number as 409, not a raw driver error', async () => {
    await asAdmin.post('/api/v1/students').send({ ...validBody, rollNo: 12 }).expect(201);

    const res = await asAdmin.post('/api/v1/students')
      .send({ ...validBody, fullName: 'Other Child', rollNo: 12 })
      .expect(409);

    expect(res.body.error.code).toBe('DUPLICATE_KEY');
    expect(res.body.error.message).toMatch(/roll number/i);
    // The internal index name and driver text must not leak to the browser.
    expect(res.body.error.message).not.toMatch(/E11000|index:/);
  });

  it('reports a duplicate student ID as 409', async () => {
    await asAdmin.post('/api/v1/students').send({ ...validBody, studentId: 'OLD-114' }).expect(201);
    const res = await asAdmin.post('/api/v1/students')
      .send({ ...validBody, studentId: 'OLD-114' })
      .expect(409);
    expect(res.body.error.message).toMatch(/already in use/i);
  });
});

describe('authorisation', () => {
  const validStudent = { ...validBody };

  it('rejects every student route without a token', async () => {
    await request(app).get('/api/v1/students').expect(401);
    await request(app).get('/api/v1/students/RNTPS-26-001').expect(401);
    await request(app).post('/api/v1/students').send(validStudent).expect(401);
    await request(app).get('/api/v1/students/stats').expect(401);
  });

  it('lets a teacher read the directory', async () => {
    const { header } = await teacherAuth(['5']);
    await request(app).get('/api/v1/students').set('Authorization', header).expect(200);
    await request(app).get('/api/v1/students/stats').set('Authorization', header).expect(200);
  });

  it('stops a teacher creating, editing or promoting students', async () => {
    const { header } = await teacherAuth(['5']);
    const created = await asAdmin.post('/api/v1/students').send(validStudent).expect(201);
    const id = created.body.studentId;

    await request(app).post('/api/v1/students').set('Authorization', header).send(validStudent).expect(403);
    await request(app).patch(`/api/v1/students/${id}`).set('Authorization', header).send({ rollNo: 5 }).expect(403);
    await request(app)
      .post(`/api/v1/students/${id}/status`)
      .set('Authorization', header)
      .send({ status: 'INACTIVE' })
      .expect(403);
    await request(app)
      .post('/api/v1/students/promote')
      .set('Authorization', header)
      .send({ fromAcademicYear: '2026-27', toAcademicYear: '2027-28', dryRun: true })
      .expect(403);
  });

  it('exposes the rollover status to an admin and hides it from a teacher', async () => {
    const { header } = await teacherAuth(['5']);
    await request(app).get('/api/v1/students/rollover-status').set('Authorization', header).expect(403);

    const res = await asAdmin.get('/api/v1/students/rollover-status').expect(200);
    expect(res.body).toMatchObject({
      activeAcademicYear: expect.any(String),
      fromAcademicYear: expect.any(String),
      toAcademicYear: expect.any(String),
      notStarted: expect.any(Boolean),
    });
    expect(res.body.steps).toMatchObject({
      feeStructuresCloned: expect.any(Boolean),
      academicYearSet: expect.any(Boolean),
      studentsPromoted: expect.any(Boolean),
    });
  });

  it('records a real promotion in the audit log but not a dry run', async () => {
    await asAdmin.post('/api/v1/students').send(validStudent).expect(201);
    await asAdmin.patch('/api/v1/settings').send({ activeAcademicYear: '2027-28' }).expect(200);
    const years = { fromAcademicYear: '2026-27', toAcademicYear: '2027-28' };

    await asAdmin.post('/api/v1/students/promote').send({ ...years, dryRun: true }).expect(200);
    expect(await AuditLog.countDocuments({ action: 'student.promote' })).toBe(0);

    await asAdmin.post('/api/v1/students/promote').send({ ...years, dryRun: false }).expect(200);
    const entry = await AuditLog.findOne({ action: 'student.promote' }).lean();
    // Who ran it and over which sessions — a wrong year pair is otherwise only visible
    // later, as classes that look wrong.
    expect(entry).toMatchObject({ entityId: '2026-27->2027-28', after: { promoted: 1 } });
  });

  it('hides whole-family guardian contact details from teachers', async () => {
    const { header } = await teacherAuth(['5']);
    const created = await asAdmin.post('/api/v1/students').send(validStudent).expect(201);

    await request(app)
      .get(`/api/v1/students/${created.body.studentId}/family-defaults`)
      .set('Authorization', header)
      .expect(403);
    await request(app).get('/api/v1/students/search-sibling?q=aa').set('Authorization', header).expect(403);
  });

  it('keeps settings entirely out of a teacher’s reach', async () => {
    const { header } = await teacherAuth(['5']);

    // Read as well as write: the payload exposes the student ID prefix and the school's
    // student and receipt counters.
    await request(app).get('/api/v1/settings').set('Authorization', header).expect(403);
    await request(app)
      .patch('/api/v1/settings')
      .set('Authorization', header)
      .send({ studentIdPrefix: 'HACKED' })
      .expect(403);
  });

  it('still gives a teacher the school name via the dashboard, which they may read', async () => {
    const { header } = await teacherAuth(['5']);
    const res = await request(app)
      .get('/api/v1/reports/dashboard')
      .set('Authorization', header)
      .expect(200);

    expect(res.body.school.name).toEqual(expect.any(String));
    expect(res.body.school.academicYear).toEqual(expect.any(String));
    // ...and nothing else from settings leaks through it.
    expect(JSON.stringify(res.body)).not.toMatch(/studentIdPrefix|counters/);
  });

  it('leaves the health probes open, since they carry no data', async () => {
    await request(app).get('/healthz').expect(200);
    await request(app).get('/api/readyz').expect(200);
  });
});

describe('editing a student after onboarding', () => {
  async function onboard() {
    const res = await asAdmin.post('/api/v1/students').send(validBody).expect(201);
    return res.body.studentId as string;
  }

  it('updates the fields an admin actually corrects', async () => {
    const studentId = await onboard();

    const res = await asAdmin
      .patch(`/api/v1/students/${studentId}`)
      .send({
        fullName: 'Aarav Kumar Sharma',
        classCode: '6',
        rollNo: 4,
        transportOpted: true,
        address: { line1: '9 New Street', city: 'Patna', state: 'Bihar', pincode: '800002' },
      })
      .expect(200);

    expect(res.body).toMatchObject({
      fullName: 'Aarav Kumar Sharma',
      classCode: '6',
      rollNo: 4,
      transportOpted: true,
    });
    expect(res.body.address.line1).toBe('9 New Street');
  });

  it('replaces guardians and re-normalises the phone number', async () => {
    const studentId = await onboard();

    const res = await asAdmin
      .patch(`/api/v1/students/${studentId}`)
      .send({
        guardians: [
          { name: 'Sunita Sharma', relation: 'MOTHER', phone: '98765 43299', isPrimary: true },
        ],
      })
      .expect(200);

    expect(res.body.guardians).toHaveLength(1);
    expect(res.body.guardians[0]).toMatchObject({ name: 'Sunita Sharma', phone: '919876543299' });
  });

  it('updates a concession, which changes what the next invoice bills', async () => {
    const studentId = await onboard();

    const res = await asAdmin
      .patch(`/api/v1/students/${studentId}`)
      .send({ concession: { type: 'PERCENT', value: 25, reason: 'Staff child' } })
      .expect(200);

    expect(res.body.concession).toEqual({ type: 'PERCENT', value: 25, reason: 'Staff child' });
  });

  it('accepts a flat discount with no reason, and clears it again', async () => {
    const studentId = await onboard();

    // Exactly what the Discount field on the student form sends: a flat amount, no reason.
    const set = await asAdmin
      .patch(`/api/v1/students/${studentId}`)
      .send({ concession: { type: 'FLAT', value: 200, reason: '' } })
      .expect(200);
    expect(set.body.concession).toEqual({ type: 'FLAT', value: 200, reason: '' });

    // Clearing the field sends NONE with a zero value, which the schema pairs strictly.
    const cleared = await asAdmin
      .patch(`/api/v1/students/${studentId}`)
      .send({ concession: { type: 'NONE', value: 0, reason: '' } })
      .expect(200);
    expect(cleared.body.concession).toEqual({ type: 'NONE', value: 0, reason: '' });
  });

  it('still enforces validation on edit, not just on create', async () => {
    const studentId = await onboard();

    // Bad phone.
    await asAdmin
      .patch(`/api/v1/students/${studentId}`)
      .send({ guardians: [{ name: 'X Y', relation: 'FATHER', phone: '123', isPrimary: true }] })
      .expect(400);

    // No primary guardian.
    await asAdmin
      .patch(`/api/v1/students/${studentId}`)
      .send({ guardians: [{ name: 'X Y', relation: 'FATHER', phone: '9876543210', isPrimary: false }] })
      .expect(400);

    // Unknown class.
    await asAdmin.patch(`/api/v1/students/${studentId}`).send({ classCode: '12' }).expect(400);
  });

  it('leaves untouched fields alone — a partial update is genuinely partial', async () => {
    const studentId = await onboard();
    const before = await asAdmin.get(`/api/v1/students/${studentId}`).expect(200);

    const after = await asAdmin
      .patch(`/api/v1/students/${studentId}`)
      .send({ rollNo: 11 })
      .expect(200);

    expect(after.body.rollNo).toBe(11);
    expect(after.body.fullName).toBe(before.body.fullName);
    expect(after.body.guardians).toEqual(before.body.guardians);
    expect(after.body.familyId).toBe(before.body.familyId);
  });

  it('cannot change the studentId or re-parent the family', async () => {
    const studentId = await onboard();

    // Both keys are stripped by the schema rather than rejected, so the record is
    // unchanged — the primary key and family link are immutable after onboarding.
    const res = await asAdmin
      .patch(`/api/v1/students/${studentId}`)
      .send({ studentId: 'HACKED-1', siblingOfStudentId: 'RNTPS-26-999', rollNo: 3 })
      .expect(200);

    expect(res.body.studentId).toBe(studentId);
    expect(res.body.rollNo).toBe(3);
  });

  it('refuses a roll number already taken in the same class', async () => {
    const first = await onboard();
    const second = await asAdmin
      .post('/api/v1/students')
      .send({ ...validBody, fullName: 'Other Child' })
      .expect(201);

    await asAdmin.patch(`/api/v1/students/${first}`).send({ rollNo: 7 }).expect(200);
    await asAdmin.patch(`/api/v1/students/${second.body.studentId}`).send({ rollNo: 7 }).expect(409);
  });

  it('is closed to teachers', async () => {
    const studentId = await onboard();
    const { header } = await teacherAuth(['5']);

    await request(app)
      .patch(`/api/v1/students/${studentId}`)
      .set('Authorization', header)
      .send({ fullName: 'Changed By Teacher' })
      .expect(403);
  });

  it('404s an unknown student', async () => {
    await asAdmin.patch('/api/v1/students/RNTPS-26-999').send({ rollNo: 1 }).expect(404);
  });
});

describe('partial edits that need the stored record to validate', () => {
  it('rejects a date of birth that lands after the stored admission date', async () => {
    const created = await asAdmin.post('/api/v1/students').send(validBody).expect(201);
    const studentId = created.body.studentId as string;

    // Only dob is sent, so the schema cannot compare the two on its own.
    const res = await asAdmin
      .patch(`/api/v1/students/${studentId}`)
      .send({ dob: '2030-01-01' })
      .expect(400);

    expect(res.body.error.message).toMatch(/before the admission date/i);
  });

  it('rejects an admission date moved before the stored date of birth', async () => {
    const created = await asAdmin.post('/api/v1/students').send(validBody).expect(201);

    await asAdmin
      .patch(`/api/v1/students/${created.body.studentId}`)
      .send({ admissionDate: '2010-01-01' })
      .expect(400);
  });

  it('accepts a valid date change', async () => {
    const created = await asAdmin.post('/api/v1/students').send(validBody).expect(201);

    const res = await asAdmin
      .patch(`/api/v1/students/${created.body.studentId}`)
      .send({ dob: '2016-01-15' })
      .expect(200);

    expect(res.body.dob).toBe('2016-01-15');
  });
});
