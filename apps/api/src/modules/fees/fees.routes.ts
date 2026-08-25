import {
  feeStructureParamsSchema,
  invoiceRunSchema,
  listInvoicesQuerySchema,
  recordPaymentSchema,
  reversePaymentSchema,
  upsertFeeStructureSchema,
  voidInvoiceSchema,
} from '@rntps/shared';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { recordAudit } from '../../lib/audit.js';
import { currentUser, requireAuth, requireRole } from '../../middleware/auth.js';
import { validate, validatedBody, validatedQuery } from '../../middleware/validate.js';
import * as service from './fees.service.js';

export const feesRoutes = Router();

// Money is admin-only throughout. Teachers have no fee responsibilities.
feesRoutes.use(requireAuth(), requireRole('ADMIN'));

// --- fee structures -------------------------------------------------------

feesRoutes.get(
  '/structures',
  asyncHandler(async (req, res) => {
    const academicYear = typeof req.query.academicYear === 'string' ? req.query.academicYear : undefined;
    res.json({ items: await service.listFeeStructures(academicYear) });
  }),
);

feesRoutes.get(
  '/structures/:classCode/:academicYear',
  validate(feeStructureParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { classCode, academicYear } = req.params as unknown as z.output<typeof feeStructureParamsSchema>;
    res.json(await service.getFeeStructure(classCode, academicYear));
  }),
);

feesRoutes.put(
  '/structures/:classCode/:academicYear',
  validate(feeStructureParamsSchema, 'params'),
  validate(upsertFeeStructureSchema),
  asyncHandler(async (req, res) => {
    const { classCode, academicYear } = req.params as unknown as z.output<typeof feeStructureParamsSchema>;
    const payload = validatedBody(req, upsertFeeStructureSchema);
    const structure = await service.upsertFeeStructure(classCode, academicYear, payload);

    await recordAudit(req, {
      action: 'fee-structure.upsert',
      entity: 'feeStructure',
      entityId: structure.id,
      after: structure,
    });
    res.json(structure);
  }),
);

const cloneSchema = z.object({
  fromAcademicYear: z.string().regex(/^\d{4}-\d{2}$/),
  toAcademicYear: z.string().regex(/^\d{4}-\d{2}$/),
});

feesRoutes.post(
  '/structures/clone',
  validate(cloneSchema),
  asyncHandler(async (req, res) => {
    const { fromAcademicYear, toAcademicYear } = validatedBody(req, cloneSchema);
    const result = await service.cloneFeeStructures(fromAcademicYear, toAcademicYear);

    await recordAudit(req, {
      action: 'fee-structure.clone',
      entity: 'feeStructure',
      entityId: `${fromAcademicYear}->${toAcademicYear}`,
      after: result,
    });
    res.json(result);
  }),
);

// --- invoice runs ---------------------------------------------------------

feesRoutes.post(
  '/runs/preview',
  validate(invoiceRunSchema),
  asyncHandler(async (req, res) => {
    const { period, classCodes } = validatedBody(req, invoiceRunSchema);
    res.json(await service.previewInvoiceRun(period, classCodes));
  }),
);

feesRoutes.post(
  '/runs/commit',
  validate(invoiceRunSchema),
  asyncHandler(async (req, res) => {
    const { period, classCodes } = validatedBody(req, invoiceRunSchema);
    const result = await service.commitInvoiceRun(period, classCodes, currentUser(req).id);

    await recordAudit(req, {
      action: 'invoice-run.commit',
      entity: 'invoiceRun',
      entityId: period,
      after: result,
    });
    res.json(result);
  }),
);

// --- invoices and payments ------------------------------------------------

feesRoutes.get(
  '/invoices',
  validate(listInvoicesQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await service.listInvoices(validatedQuery(req, listInvoicesQuerySchema)));
  }),
);

feesRoutes.get(
  '/invoices/:invoiceId',
  asyncHandler(async (req, res) => {
    res.json(await service.getInvoice(String(req.params.invoiceId)));
  }),
);

// The bill a parent is handed, as distinct from the receipt that proves they paid.
feesRoutes.get(
  '/invoices/:invoiceId/slip',
  asyncHandler(async (req, res) => {
    res.json(await service.getFeeSlip(String(req.params.invoiceId)));
  }),
);

feesRoutes.post(
  '/invoices/:invoiceId/payments',
  validate(recordPaymentSchema),
  asyncHandler(async (req, res) => {
    const invoiceId = String(req.params.invoiceId);
    const payload = validatedBody(req, recordPaymentSchema);
    const invoice = await service.recordPayment(invoiceId, payload, currentUser(req).id);

    await recordAudit(req, {
      action: 'payment.record',
      entity: 'invoice',
      entityId: invoiceId,
      after: { amountRupees: payload.amountRupees, mode: payload.mode, status: invoice.status },
    });
    res.status(201).json(invoice);
  }),
);

feesRoutes.post(
  '/invoices/:invoiceId/payments/:receiptNo/reverse',
  validate(reversePaymentSchema),
  asyncHandler(async (req, res) => {
    const invoiceId = String(req.params.invoiceId);
    const receiptNo = String(req.params.receiptNo);
    const { reason } = validatedBody(req, reversePaymentSchema);
    const invoice = await service.reversePayment(invoiceId, receiptNo, reason);

    await recordAudit(req, {
      action: 'payment.reverse',
      entity: 'invoice',
      entityId: invoiceId,
      after: { receiptNo, reason, status: invoice.status },
    });
    res.json(invoice);
  }),
);

feesRoutes.post(
  '/invoices/:invoiceId/void',
  validate(voidInvoiceSchema),
  asyncHandler(async (req, res) => {
    const invoiceId = String(req.params.invoiceId);
    const { reason } = validatedBody(req, voidInvoiceSchema);
    const invoice = await service.voidInvoice(invoiceId, reason);

    await recordAudit(req, { action: 'invoice.void', entity: 'invoice', entityId: invoiceId, after: { reason } });
    res.json(invoice);
  }),
);

feesRoutes.get(
  '/students/:studentId/invoices',
  asyncHandler(async (req, res) => {
    res.json({ items: await service.getStudentInvoices(String(req.params.studentId)) });
  }),
);
