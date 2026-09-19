import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { SETTINGS_ID, Settings } from '../../models/Settings.js';
import { adminAuth, seedSettings, teacherAuth } from '../../test/factories.js';

let app: Express;
let adminHeader: string;

beforeEach(async () => {
  await seedSettings();
  app = createApp();
  adminHeader = (await adminAuth()).header;
});

/**
 * The split that makes a report card printable by the teacher who teaches the class.
 *
 * `GET /settings` stays admin-only because it carries the ID prefix and the school's
 * counters; the letterhead a printed document needs is a separate, smaller response.
 */
describe('GET /api/v1/settings/school', () => {
  it('gives a teacher the letterhead', async () => {
    const { header } = await teacherAuth(['5']);

    const res = await request(app)
      .get('/api/v1/settings/school')
      .set('Authorization', header)
      .expect(200);

    expect(res.body.schoolName).toBeTruthy();
    expect(res.body).toHaveProperty('schoolAddress');
    expect(res.body).toHaveProperty('activeAcademicYear');
    // The report card pages are the reason this endpoint exists, and they cannot resolve
    // a bare link without it.
    expect(res.body.defaultReportScope).toBe('ALL');
  });

  it('reports the default a settings document predating the setting falls back to', async () => {
    // A default only applies when a document is created, and this one already exists —
    // which is the case every deployed install is in the first time it reads this.
    await Settings.updateOne({ _id: SETTINGS_ID }, { $unset: { defaultReportScope: '' } });
    const { header } = await teacherAuth(['5']);

    const res = await request(app)
      .get('/api/v1/settings/school')
      .set('Authorization', header)
      .expect(200);
    expect(res.body.defaultReportScope).toBe('ALL');
  });

  it('reports what an admin has chosen', async () => {
    await request(app)
      .patch('/api/v1/settings')
      .set('Authorization', adminHeader)
      .send({ defaultReportScope: 'FINAL' })
      .expect(200);
    const { header } = await teacherAuth(['5']);

    const res = await request(app)
      .get('/api/v1/settings/school')
      .set('Authorization', header)
      .expect(200);
    expect(res.body.defaultReportScope).toBe('FINAL');
  });

  it('carries nothing a teacher may not read', async () => {
    const { header } = await teacherAuth(['5']);

    const res = await request(app)
      .get('/api/v1/settings/school')
      .set('Authorization', header)
      .expect(200);

    // Absent from the shape, not filtered out of it — that is the whole point of the
    // second endpoint, and the assertion that fails if someone widens it back.
    expect(res.body).not.toHaveProperty('counters');
    expect(res.body).not.toHaveProperty('studentIdPrefix');
    expect(res.body).not.toHaveProperty('templates');
    expect(res.body).not.toHaveProperty('holidays');
  });

  it('requires a signed-in user', async () => {
    await request(app).get('/api/v1/settings/school').expect(401);
  });
});

describe('GET /api/v1/settings', () => {
  it('stays admin-only', async () => {
    const { header } = await teacherAuth(['5']);
    await request(app).get('/api/v1/settings').set('Authorization', header).expect(403);
  });

  it('refuses a scope that is not a paper or the whole session', async () => {
    await request(app)
      .patch('/api/v1/settings')
      .set('Authorization', adminHeader)
      .send({ defaultReportScope: 'DRAWING' })
      .expect(400);
  });

  it('will not let a teacher change the default', async () => {
    const { header } = await teacherAuth(['5']);
    await request(app)
      .patch('/api/v1/settings')
      .set('Authorization', header)
      .send({ defaultReportScope: 'FINAL' })
      .expect(403);
  });

  it('returns the full payload to an admin', async () => {
    const res = await request(app)
      .get('/api/v1/settings')
      .set('Authorization', adminHeader)
      .expect(200);

    expect(res.body.studentIdPrefix).toBeTruthy();
    expect(res.body.counters).toBeTruthy();
  });
});
