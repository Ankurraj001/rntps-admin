import {
  formatAadhaar,
  isValidAadhaar,
  isValidApaarId,
  isValidVerhoeff,
  maskAadhaar,
  normaliseApaarId,
  verhoeffCheckDigit,
} from '@rntps/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { adminAuth, seedSettings } from '../../test/factories.js';

/** Builds an Aadhaar-shaped number with a correct check digit. */
function validAadhaar(seed: number): string {
  let payload = String(2 + (seed % 8));
  for (let i = 0; i < 10; i += 1) payload += String((seed * (i + 7)) % 10);
  return payload + String(verhoeffCheckDigit(payload));
}

describe('Verhoeff checksum', () => {
  it('round-trips a generated check digit', () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      expect(isValidVerhoeff(validAadhaar(seed))).toBe(true);
    }
  });

  it('catches every single-digit typo — the reason this check exists', () => {
    const number = validAadhaar(7);
    for (let position = 0; position < number.length; position += 1) {
      for (let digit = 0; digit <= 9; digit += 1) {
        if (Number(number[position]) === digit) continue;
        const typo = number.slice(0, position) + digit + number.slice(position + 1);
        expect(isValidVerhoeff(typo), `typo at ${position} -> ${digit}`).toBe(false);
      }
    }
  });

  it('catches every transposition of adjacent digits', () => {
    const number = validAadhaar(11);
    for (let i = 0; i < number.length - 1; i += 1) {
      if (number[i] === number[i + 1]) continue;
      const swapped = number.slice(0, i) + number[i + 1] + number[i] + number.slice(i + 2);
      expect(isValidVerhoeff(swapped), `swap at ${i}`).toBe(false);
    }
  });
});

describe('Aadhaar validation', () => {
  it('accepts a valid number, spaced or not', () => {
    const number = validAadhaar(3);
    expect(isValidAadhaar(number)).toBe(true);
    expect(isValidAadhaar(formatAadhaar(number))).toBe(true);
    expect(isValidAadhaar(number.replace(/(\d{4})(?=\d)/g, '$1-'))).toBe(true);
  });

  it('rejects a number starting 0 or 1, which UIDAI never issues', () => {
    for (const lead of ['0', '1']) {
      const payload = lead + validAadhaar(5).slice(1, 11);
      expect(isValidAadhaar(payload + String(verhoeffCheckDigit(payload)))).toBe(false);
    }
  });

  it('rejects the wrong length and non-numeric input', () => {
    expect(isValidAadhaar('23456789')).toBe(false);
    expect(isValidAadhaar('2345678901234')).toBe(false);
    expect(isValidAadhaar('')).toBe(false);
    expect(isValidAadhaar('abcdefghijkl')).toBe(false);
  });

  it('formats in groups of four and masks to the last four', () => {
    expect(formatAadhaar('234567890123')).toBe('2345 6789 0123');
    expect(maskAadhaar('234567890123')).toBe('XXXX XXXX 0123');
  });
});

describe('APAAR ID validation', () => {
  it('accepts 8 to 20 letters or digits and uppercases them', () => {
    expect(isValidApaarId('123456789012')).toBe(true);
    expect(isValidApaarId('ab12cd34ef')).toBe(true);
    expect(normaliseApaarId('ab12-cd34 ef')).toBe('AB12CD34EF');
  });

  it('rejects something too short or containing punctuation', () => {
    expect(isValidApaarId('1234')).toBe(false);
    expect(isValidApaarId('12345678!')).toBe(false);
  });
});

describe('the identifiers through the API', () => {
  let app: Express;
  let adminHeader: string;

  const base = {
    fullName: 'Aarav Sharma',
    dob: '2015-06-14',
    gender: 'MALE',
    classCode: '5',
    admissionDate: '2026-04-01',
    guardians: [{ name: 'Rakesh Sharma', relation: 'FATHER', phone: '9876543210', isPrimary: true }],
  };

  const post = (body: unknown) =>
    request(app).post('/api/v1/students').set('Authorization', adminHeader).send(body);

  beforeEach(async () => {
    await seedSettings();
    app = createApp();
    adminHeader = (await adminAuth()).header;
  });

  it('stores both identifiers, normalising the spacing', () => {
    const aadhaar = validAadhaar(21);
    return post({ ...base, aadhaar: formatAadhaar(aadhaar), apaarId: 'ab12-cd34-ef56' })
      .expect(201)
      .then((res) => {
        expect(res.body.aadhaar).toBe(aadhaar);
        expect(res.body.apaarId).toBe('AB12CD34EF56');
      });
  });

  it('leaves them null when omitted or blank', async () => {
    const omitted = await post(base).expect(201);
    expect(omitted.body.aadhaar).toBeNull();
    expect(omitted.body.apaarId).toBeNull();

    // A blank text input posts "", which must mean "not provided".
    const blank = await post({ ...base, fullName: 'Blank Fields', aadhaar: '', apaarId: '' }).expect(201);
    expect(blank.body.aadhaar).toBeNull();
  });

  it('rejects an Aadhaar with a bad check digit', async () => {
    const valid = validAadhaar(31);
    const broken = valid.slice(0, 11) + String((Number(valid[11]) + 1) % 10);

    const res = await post({ ...base, aadhaar: broken }).expect(400);
    expect(res.body.error.details).toContainEqual(
      expect.objectContaining({ field: 'aadhaar', message: expect.stringMatching(/valid 12-digit/i) }),
    );
  });

  it('refuses the same Aadhaar on two students', async () => {
    const aadhaar = validAadhaar(41);
    await post({ ...base, aadhaar }).expect(201);

    const res = await post({ ...base, fullName: 'Duplicate Aadhaar', aadhaar }).expect(409);
    expect(res.body.error.message).toMatch(/already has that Aadhaar/i);
  });

  it('refuses the same APAAR ID on two students', async () => {
    await post({ ...base, apaarId: '123456789012' }).expect(201);
    const res = await post({ ...base, fullName: 'Duplicate APAAR', apaarId: '123456789012' }).expect(409);
    expect(res.body.error.message).toMatch(/already has that APAAR/i);
  });

  it('lets many students have no identifiers at all', async () => {
    // The unique indexes use a partial filter, not sparse — otherwise every student
    // without an Aadhaar would collide with every other on the null value.
    for (const name of ['One Student', 'Two Student', 'Three Student']) {
      await post({ ...base, fullName: name }).expect(201);
    }

    const list = await request(app)
      .get('/api/v1/students')
      .set('Authorization', adminHeader)
      .expect(200);
    expect(list.body.total).toBe(3);
  });

  it('finds a student by either identifier', async () => {
    const aadhaar = validAadhaar(51);
    await post({ ...base, aadhaar, apaarId: 'PEN123456789' }).expect(201);

    const byAadhaar = await request(app)
      .get(`/api/v1/students?q=${aadhaar}`)
      .set('Authorization', adminHeader)
      .expect(200);
    expect(byAadhaar.body.total).toBe(1);

    const byApaar = await request(app)
      .get('/api/v1/students?q=PEN123456789')
      .set('Authorization', adminHeader)
      .expect(200);
    expect(byApaar.body.total).toBe(1);
  });

  it('can be added and corrected on an existing student', async () => {
    const created = await post(base).expect(201);
    const aadhaar = validAadhaar(61);

    const added = await request(app)
      .patch(`/api/v1/students/${created.body.studentId}`)
      .set('Authorization', adminHeader)
      .send({ aadhaar: formatAadhaar(aadhaar), apaarId: 'PEN000111222' })
      .expect(200);
    expect(added.body.aadhaar).toBe(aadhaar);

    // A bad value on edit is rejected too, not just on create.
    await request(app)
      .patch(`/api/v1/students/${created.body.studentId}`)
      .set('Authorization', adminHeader)
      .send({ aadhaar: '111111111111' })
      .expect(400);
  });
});

describe('clearing an identifier', () => {
  let app: Express;
  let adminHeader: string;

  const base = {
    fullName: 'Aarav Sharma',
    dob: '2015-06-14',
    gender: 'MALE',
    classCode: '5',
    admissionDate: '2026-04-01',
    guardians: [{ name: 'Rakesh Sharma', relation: 'FATHER', phone: '9876543210', isPrimary: true }],
  };

  beforeEach(async () => {
    await seedSettings();
    app = createApp();
    adminHeader = (await adminAuth()).header;
  });

  it('an emptied field removes the stored value', async () => {
    const aadhaar = validAadhaar(71);
    const created = await request(app)
      .post('/api/v1/students')
      .set('Authorization', adminHeader)
      .send({ ...base, aadhaar, apaarId: 'PEN999888777' })
      .expect(201);

    const cleared = await request(app)
      .patch(`/api/v1/students/${created.body.studentId}`)
      .set('Authorization', adminHeader)
      .send({ aadhaar: '', apaarId: '' })
      .expect(200);

    expect(cleared.body.aadhaar).toBeNull();
    expect(cleared.body.apaarId).toBeNull();
  });

  it('frees the number for the student it actually belongs to', async () => {
    const aadhaar = validAadhaar(81);

    // Entered against the wrong student.
    const wrong = await request(app)
      .post('/api/v1/students')
      .set('Authorization', adminHeader)
      .send({ ...base, fullName: 'Wrong Student', aadhaar })
      .expect(201);

    // The right student is blocked while the number is held.
    await request(app)
      .post('/api/v1/students')
      .set('Authorization', adminHeader)
      .send({ ...base, fullName: 'Right Student', aadhaar })
      .expect(409);

    // Clear it, and the number becomes available.
    await request(app)
      .patch(`/api/v1/students/${wrong.body.studentId}`)
      .set('Authorization', adminHeader)
      .send({ aadhaar: '' })
      .expect(200);

    await request(app)
      .post('/api/v1/students')
      .set('Authorization', adminHeader)
      .send({ ...base, fullName: 'Right Student', aadhaar })
      .expect(201);
  });

  it('omitting the field entirely still leaves it untouched', async () => {
    const aadhaar = validAadhaar(91);
    const created = await request(app)
      .post('/api/v1/students')
      .set('Authorization', adminHeader)
      .send({ ...base, aadhaar })
      .expect(201);

    const res = await request(app)
      .patch(`/api/v1/students/${created.body.studentId}`)
      .set('Authorization', adminHeader)
      .send({ rollNo: 5 })
      .expect(200);

    expect(res.body.aadhaar).toBe(aadhaar);
  });
});
