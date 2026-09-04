import {
  attendanceSummaryQuerySchema,
  monthlyQuerySchema,
  rosterQuerySchema,
  saveRosterSchema,
  saveStaffRosterSchema,
  staffMonthlyQuerySchema,
  staffRosterQuerySchema,
  studentAttendanceQuerySchema,
} from '@rntps/shared';
import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { recordAudit } from '../../lib/audit.js';
import { currentUser, requireAuth, requireClassAccess, requireRole } from '../../middleware/auth.js';
import { validate, validatedBody, validatedQuery } from '../../middleware/validate.js';
import * as service from './attendance.service.js';
import * as staff from './staff.service.js';

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

/**
 * Teacher attendance.
 *
 * requireClassAccess() is deliberately absent from all three: there is no classCode in the
 * params, query or body, so its extractor would find nothing and reject every teacher with
 * "A class must be specified" while silently waving admins through — a failure that only
 * shows up for non-admins.
 */
attendanceRoutes.get(
  '/staff/roster',
  requireRole('ADMIN'),
  validate(staffRosterQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { dateKey } = validatedQuery(req, staffRosterQuerySchema);
    res.json(await staff.getStaffRoster(dateKey));
  }),
);

attendanceRoutes.put(
  '/staff/roster',
  requireRole('ADMIN'),
  validate(saveStaffRosterSchema),
  asyncHandler(async (req, res) => {
    const payload = validatedBody(req, saveStaffRosterSchema);
    const result = await staff.saveStaffRoster(payload, currentUser(req).id);

    await recordAudit(req, {
      action: 'staff-attendance.save',
      entity: 'staffAttendance',
      // No classCode exists here, so the day alone identifies the write.
      entityId: payload.dateKey,
      after: { dateKey: payload.dateKey, count: result.saved },
    });

    res.json(result);
  }),
);

/**
 * Readable by any signed-in user, which is what lets a teacher see the register they are on.
 * Safe because the response carries only a user id and a name — never the email, phone or
 * sign-in details that make GET /users admin-only.
 */
attendanceRoutes.get(
  '/staff/monthly',
  validate(staffMonthlyQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { month } = validatedQuery(req, staffMonthlyQuerySchema);
    res.json(await staff.getStaffMonthly(month));
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
