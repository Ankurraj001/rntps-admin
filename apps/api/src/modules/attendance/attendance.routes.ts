import {
  attendanceSummaryQuerySchema,
  monthlyQuerySchema,
  rosterQuerySchema,
  saveRosterSchema,
  studentAttendanceQuerySchema,
} from '@rntps/shared';
import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { recordAudit } from '../../lib/audit.js';
import { currentUser, requireAuth, requireClassAccess, requireRole } from '../../middleware/auth.js';
import { validate, validatedBody, validatedQuery } from '../../middleware/validate.js';
import * as service from './attendance.service.js';

export const attendanceRoutes = Router();

attendanceRoutes.use(requireAuth());

/**
 * Teachers may only touch their assigned classes. requireClassAccess reads classCode
 * from params, query or body, so moving the parameter between them does not get past it.
 */
attendanceRoutes.get(
  '/roster',
  validate(rosterQuerySchema, 'query'),
  requireClassAccess(),
  asyncHandler(async (req, res) => {
    const { classCode, dateKey } = validatedQuery(req, rosterQuerySchema);
    res.json(await service.getRoster(classCode, dateKey));
  }),
);

attendanceRoutes.put(
  '/roster',
  validate(saveRosterSchema),
  requireClassAccess(),
  asyncHandler(async (req, res) => {
    const payload = validatedBody(req, saveRosterSchema);
    const user = currentUser(req);
    const result = await service.saveRoster(payload, user.id);

    await recordAudit(req, {
      action: 'attendance.save',
      entity: 'attendance',
      entityId: `${payload.classCode}:${payload.dateKey}`,
      after: { classCode: payload.classCode, dateKey: payload.dateKey, count: result.saved },
    });

    res.json(result);
  }),
);

attendanceRoutes.get(
  '/monthly',
  validate(monthlyQuerySchema, 'query'),
  requireClassAccess(),
  asyncHandler(async (req, res) => {
    const { classCode, month } = validatedQuery(req, monthlyQuerySchema);
    res.json(await service.getMonthly(classCode, month));
  }),
);

// School-wide, so admin-only: a teacher has no business seeing other classes' figures.
attendanceRoutes.get(
  '/defaulters',
  requireRole('ADMIN'),
  validate(attendanceSummaryQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { month, threshold, classCode } = validatedQuery(req, attendanceSummaryQuerySchema);
    res.json(await service.getDefaulters(month, threshold, classCode));
  }),
);

attendanceRoutes.get(
  '/unmarked',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const classes = await service.getUnmarkedClasses();
    // A teacher only needs to be nudged about their own classes.
    res.json({
      classes: user.role === 'ADMIN' ? classes : classes.filter((code) => user.classes.includes(code)),
    });
  }),
);

attendanceRoutes.get(
  '/student/:studentId',
  validate(studentAttendanceQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const range = validatedQuery(req, studentAttendanceQuerySchema);
    res.json(await service.getStudentAttendance(String(req.params.studentId), range));
  }),
);
