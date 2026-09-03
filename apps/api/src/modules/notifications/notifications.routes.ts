import { createBatchSchema, updateItemStatusSchema } from '@rntps/shared';
import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { recordAudit } from '../../lib/audit.js';
import { currentUser, requireAuth, requireRole } from '../../middleware/auth.js';
import { validate, validatedBody } from '../../middleware/validate.js';
import * as service from './notifications.service.js';

export const notificationRoutes = Router();

// Sending money reminders to parents is an admin responsibility.
notificationRoutes.use(requireAuth(), requireRole('ADMIN'));

notificationRoutes.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ items: await service.listBatches() });
  }),
);

notificationRoutes.post(
  '/',
  validate(createBatchSchema),
  asyncHandler(async (req, res) => {
    const payload = validatedBody(req, createBatchSchema);
    const batch = await service.createBatch(payload, currentUser(req).id);

    await recordAudit(req, {
      action: 'notification-batch.create',
      entity: 'notification',
      entityId: batch.id,
      after: { type: batch.type, totalCount: batch.totalCount, filter: batch.filter },
    });

    res.status(201).json(batch);
  }),
);

notificationRoutes.get(
  '/:batchId',
  asyncHandler(async (req, res) => {
    res.json(await service.getBatch(String(req.params.batchId)));
  }),
);

// One invoice's bill, addressed to whichever guardian is reachable — as opposed to
// POST /, which builds a message per guardian across a whole filtered batch.
notificationRoutes.get(
  '/invoices/:invoiceId/whatsapp-link',
  asyncHandler(async (req, res) => {
    res.json(await service.buildInvoiceWaLink(String(req.params.invoiceId)));
  }),
);

notificationRoutes.patch(
  '/:batchId/items/:itemKey',
  validate(updateItemStatusSchema),
  asyncHandler(async (req, res) => {
    const { status } = validatedBody(req, updateItemStatusSchema);
    res.json(
      await service.setItemStatus(
        String(req.params.batchId),
        String(req.params.itemKey),
        status,
        currentUser(req).id,
      ),
    );
  }),
);
