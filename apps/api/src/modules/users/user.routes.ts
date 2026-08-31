import { createUserSchema, resetPasswordSchema, updateUserSchema } from '@rntps/shared';
import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { recordAudit } from '../../lib/audit.js';
import { currentUser, requireAuth, requireRole } from '../../middleware/auth.js';
import { validate, validatedBody } from '../../middleware/validate.js';
import * as service from './user.service.js';

export const userRoutes = Router();

// Everything here is admin-only.
userRoutes.use(requireAuth(), requireRole('ADMIN'));

userRoutes.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ items: await service.listUsers() });
  }),
);

userRoutes.post(
  '/',
  validate(createUserSchema),
  asyncHandler(async (req, res) => {
    const payload = validatedBody(req, createUserSchema);
    const result = await service.createUser(payload, currentUser(req).id);

    await recordAudit(req, {
      action: result.invited ? 'user.invited' : 'user.create',
      entity: 'user',
      entityId: result.user.id,
      after: { ...result.user, invited: result.invited },
    });

    res.status(201).json(result);
  }),
);

userRoutes.patch(
  '/:userId',
  validate(updateUserSchema),
  asyncHandler(async (req, res) => {
    const userId = String(req.params.userId);
    const payload = validatedBody(req, updateUserSchema);
    const user = await service.updateUser(userId, payload, currentUser(req));

    await recordAudit(req, { action: 'user.update', entity: 'user', entityId: userId, after: user });
    res.json(user);
  }),
);

userRoutes.post(
  '/:userId/deactivate',
  asyncHandler(async (req, res) => {
    const userId = String(req.params.userId);
    const user = await service.setUserActive(userId, false, currentUser(req));

    await recordAudit(req, { action: 'user.deactivate', entity: 'user', entityId: userId, after: user });
    res.json(user);
  }),
);

userRoutes.post(
  '/:userId/activate',
  asyncHandler(async (req, res) => {
    const userId = String(req.params.userId);
    const user = await service.setUserActive(userId, true, currentUser(req));

    await recordAudit(req, { action: 'user.activate', entity: 'user', entityId: userId, after: user });
    res.json(user);
  }),
);

userRoutes.post(
  '/:userId/reset-password',
  validate(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    const userId = String(req.params.userId);
    const { newPassword } = validatedBody(req, resetPasswordSchema);
    const result = await service.resetPassword(userId, newPassword);

    // The temporary password itself is scrubbed by recordAudit.
    await recordAudit(req, {
      action: 'user.reset-password',
      entity: 'user',
      entityId: userId,
      after: { invited: result.invited },
    });
    res.json(result);
  }),
);

userRoutes.post(
  '/:userId/unlock',
  asyncHandler(async (req, res) => {
    const userId = String(req.params.userId);
    const user = await service.unlockUser(userId);

    await recordAudit(req, { action: 'user.unlock', entity: 'user', entityId: userId, after: user });
    res.json(user);
  }),
);
