import {
  addChargeSchema,
  createStudentSchema,
  listStudentsQuerySchema,
  promoteStudentsSchema,
  updateStudentSchema,
  updateStudentStatusSchema,
} from '@rntps/shared';
import type { Request, Response } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { recordAudit } from '../../lib/audit.js';
import { currentUser } from '../../middleware/auth.js';
import { validatedBody, validatedQuery } from '../../middleware/validate.js';
import * as service from './student.service.js';

export const list = asyncHandler(async (req: Request, res: Response) => {
  res.json(await service.listStudents(validatedQuery(req, listStudentsQuerySchema)));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  res.json(await service.getStudent(String(req.params.studentId)));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const student = await service.createStudent(validatedBody(req, createStudentSchema));
  res.status(201).json(student);
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const payload = validatedBody(req, updateStudentSchema);
  res.json(await service.updateStudent(String(req.params.studentId), payload));
});

export const changeStatus = asyncHandler(async (req: Request, res: Response) => {
  const { status, reason } = validatedBody(req, updateStudentStatusSchema);
  res.json(await service.setStudentStatus(String(req.params.studentId), status, reason));
});

export const siblings = asyncHandler(async (req: Request, res: Response) => {
  res.json({ items: await service.getSiblings(String(req.params.studentId)) });
});

export const familyDefaults = asyncHandler(async (req: Request, res: Response) => {
  res.json(await service.getFamilyDefaults(String(req.params.studentId)));
});

export const searchSiblings = asyncHandler(async (req: Request, res: Response) => {
  const term = typeof req.query.q === 'string' ? req.query.q : '';
  res.json({ items: await service.searchSiblingCandidates(term) });
});

/**
 * Audited because it rewrites every student in the school in one call, and a mistaken year
 * pair is only visible afterwards as classes that look wrong. A dry run changes nothing, so
 * only a real run is recorded.
 */
export const promote = asyncHandler(async (req: Request, res: Response) => {
  const payload = validatedBody(req, promoteStudentsSchema);
  const result = await service.promoteStudents(payload);

  if (!payload.dryRun) {
    await recordAudit(req, {
      action: 'student.promote',
      entity: 'student',
      entityId: `${payload.fromAcademicYear}->${payload.toAcademicYear}`,
      after: {
        promoted: result.promoted.length,
        graduated: result.graduated.length,
        skipped: result.skipped.length,
        ...(payload.classCodes?.length ? { classCodes: payload.classCodes } : {}),
      },
    });
  }
  res.json(result);
});

export const rolloverStatus = asyncHandler(async (_req: Request, res: Response) => {
  res.json(await service.getRolloverStatus());
});

export const stats = asyncHandler(async (_req: Request, res: Response) => {
  const [byClass, missingWhatsapp] = await Promise.all([
    service.countByClass(),
    service.studentsWithoutWhatsapp(),
  ]);
  res.json({
    byClass,
    totalActive: byClass.reduce((sum, row) => sum + row.count, 0),
    missingWhatsapp,
  });
});

// --- charges -------------------------------------------------------------
//
// A charge waits on the student until the next monthly invoice absorbs it, so these
// endpoints never create an invoice themselves.

export const listCharges = asyncHandler(async (req: Request, res: Response) => {
  res.json({ items: await service.listCharges(String(req.params.studentId)) });
});

export const addCharge = asyncHandler(async (req: Request, res: Response) => {
  const payload = validatedBody(req, addChargeSchema);
  const items = await service.addCharge(String(req.params.studentId), payload, currentUser(req).id);
  res.status(201).json({ items });
});

export const removeCharge = asyncHandler(async (req: Request, res: Response) => {
  const items = await service.removeCharge(
    String(req.params.studentId),
    String(req.params.chargeId),
  );
  res.json({ items });
});
