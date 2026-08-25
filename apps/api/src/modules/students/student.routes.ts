import {
  addChargeSchema,
  createStudentSchema,
  listStudentsQuerySchema,
  promoteStudentsSchema,
  updateStudentSchema,
  updateStudentStatusSchema,
} from '@rntps/shared';
import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './student.controller.js';

export const studentRoutes = Router();

// Every student route needs a signed-in user. Teachers get read access to the directory
// because they need to look up the children they teach; anything that changes a record
// is admin-only.
studentRoutes.use(requireAuth());

const adminOnly = requireRole('ADMIN');

// Static paths are declared before /:studentId so they are not swallowed by it.
studentRoutes.get('/stats', controller.stats);
studentRoutes.get('/search-sibling', adminOnly, controller.searchSiblings);
studentRoutes.get('/rollover-status', adminOnly, controller.rolloverStatus);
studentRoutes.post('/promote', adminOnly, validate(promoteStudentsSchema), controller.promote);

studentRoutes.get('/', validate(listStudentsQuerySchema, 'query'), controller.list);
studentRoutes.post('/', adminOnly, validate(createStudentSchema), controller.create);

studentRoutes.get('/:studentId', controller.getOne);
studentRoutes.patch('/:studentId', adminOnly, validate(updateStudentSchema), controller.update);
studentRoutes.post(
  '/:studentId/status',
  adminOnly,
  validate(updateStudentStatusSchema),
  controller.changeStatus,
);
// Money, so admin-only throughout — same rule as the fees module.
studentRoutes.get('/:studentId/charges', adminOnly, controller.listCharges);
studentRoutes.post('/:studentId/charges', adminOnly, validate(addChargeSchema), controller.addCharge);
studentRoutes.delete('/:studentId/charges/:chargeId', adminOnly, controller.removeCharge);

studentRoutes.get('/:studentId/siblings', controller.siblings);
// Exposes a whole family's guardian contact details, so it stays admin-only.
studentRoutes.get('/:studentId/family-defaults', adminOnly, controller.familyDefaults);
