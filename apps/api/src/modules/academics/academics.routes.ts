import {
  listAcademicsQuerySchema,
  reportCardParamsSchema,
  reportCardQuerySchema,
  saveExamResultSchema,
  studentAcademicsParamsSchema,
} from '@rntps/shared';
import { Router } from 'express';
import { AppError } from '../../lib/AppError.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { recordAudit } from '../../lib/audit.js';
import { currentUser, requireAuth } from '../../middleware/auth.js';
import { validate, validatedBody, validatedQuery } from '../../middleware/validate.js';
import * as service from './academics.service.js';

export const academicsRoutes = Router();

academicsRoutes.use(requireAuth());

/**
 * requireClassAccess() is deliberately absent from this whole module.
 *
 * On the list, classCode is optional — "All classes" is a real choice — so its extractor
 * would find nothing and reject every teacher with "A class must be specified" while
 * waving admins straight through, a failure that only shows up for non-admins. On the
 * save there is no classCode in the body at all, by design: the class comes from the
 * student record, so that naming one in the request cannot reach another teacher's class.
 *
 * The confinement is still enforced, just closer to the data — here for the list, and
 * inside the service for the save, where the student has been loaded.
 */
academicsRoutes.get(
  '/',
  validate(listAcademicsQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const query = validatedQuery(req, listAcademicsQuerySchema);
    const user = currentUser(req);
    const allowedClasses = user.role === 'ADMIN' ? undefined : user.classes;

    // Refused rather than quietly returning an empty page, so a teacher who lands on
    // another class's gradebook is told why instead of thinking it has no students.
    if (query.classCode && allowedClasses && !allowedClasses.includes(query.classCode)) {
      throw AppError.forbidden(`You are not assigned to ${query.classCode}`);
    }

    res.json(await service.listAcademics(query, allowedClasses));
  }),
);

/** Populates the session dropdown. Carries no marks, so it needs no class scoping. */
academicsRoutes.get(
  '/years',
  asyncHandler(async (_req, res) => {
    res.json(await service.listAcademicYears());
  }),
);

/**
 * Readable by any signed-in user, matching GET /attendance/student/:studentId — a teacher
 * looking at a student's record can see the same page an admin does.
 */
academicsRoutes.get(
  '/student/:studentId',
  asyncHandler(async (req, res) => {
    const { studentId } = studentAcademicsParamsSchema.parse(req.params);
    res.json(await service.getStudentAcademics(studentId));
  }),
);

/**
 * The report card as a WhatsApp message, addressed to the reachable guardian.
 *
 * Unlike the read above, this is confined to a teacher's own classes — sending a parent a
 * message is an outward act, not an internal lookup. The check is inside the service,
 * against the class snapshot on the record, for the same reason the save's is.
 */
academicsRoutes.get(
  '/report-card/:studentId/:academicYear/whatsapp-link',
  // Through the middleware rather than a bare .parse(): a ZodError thrown inside a handler
  // is not an AppError, so errorHandler would report a bad exam code as a 500.
  validate(reportCardQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { studentId } = studentAcademicsParamsSchema.parse(req.params);
    const { academicYear } = reportCardParamsSchema.parse(req.params);
    const { exam } = validatedQuery(req, reportCardQuerySchema);
    res.json(await service.buildReportCardWaLink(studentId, academicYear, currentUser(req), exam));
  }),
);

academicsRoutes.put(
  '/marks',
  validate(saveExamResultSchema),
  asyncHandler(async (req, res) => {
    const payload = validatedBody(req, saveExamResultSchema);
    const user = currentUser(req);
    const row = await service.saveExamResult(payload, user);

    await recordAudit(req, {
      action: 'academics.save',
      entity: 'examResult',
      entityId: `${payload.studentId}:${payload.academicYear}`,
      // Both halves: what the teacher typed, and what it worked out to. The percentages
      // are read off the saved row rather than the payload, because the payload no longer
      // carries any — they are derived, and a legacy one may have been carried forward.
      after: {
        studentId: payload.studentId,
        academicYear: payload.academicYear,
        classCode: row.classCode,
        subjectMarks: payload.subjectMarks,
        subjectGrades: payload.subjectGrades,
        scores: row.scores,
      },
    });

    res.json(row);
  }),
);
