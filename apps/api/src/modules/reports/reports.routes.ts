import { classLabel, collectionReportQuerySchema, duesReportQuerySchema } from '@rntps/shared';
import { Router, type Response } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { csvFilename, rupeesForCsv, toCsv } from '../../lib/csv.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate, validatedQuery } from '../../middleware/validate.js';
import * as service from './reports.service.js';

export const reportRoutes = Router();

reportRoutes.use(requireAuth());

function sendCsv(res: Response, filename: string, body: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // Excel needs a byte-order mark to read UTF-8 (student names) correctly. Written as
  // an escape rather than a literal BOM so it is visible in the source.
  res.send(`\uFEFF${body}`);
}

/** The dashboard is the one report a teacher may see, scoped by the UI to their classes. */
reportRoutes.get(
  '/dashboard',
  asyncHandler(async (_req, res) => {
    res.json(await service.getDashboard());
  }),
);

reportRoutes.get(
  '/dues',
  requireRole('ADMIN'),
  validate(duesReportQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const filters = validatedQuery(req, duesReportQuerySchema);
    const report = await service.getDuesReport(filters);

    if (req.query.format === 'csv') {
      sendCsv(
        res,
        csvFilename('dues', new Date().toISOString().slice(0, 10)),
        toCsv(
          ['Student ID', 'Name', 'Class', 'Family', 'Invoices', 'Oldest due', 'Billed', 'Paid', 'Balance', 'Age'],
          report.rows.map((row) => [
            row.studentId,
            row.studentName,
            classLabel(row.classCode),
            row.familyId,
            row.invoiceCount,
            row.oldestDueDate,
            rupeesForCsv(row.totalRupees),
            rupeesForCsv(row.paidRupees),
            rupeesForCsv(row.balanceRupees),
            row.bucket,
          ]),
        ),
      );
      return;
    }

    res.json(report);
  }),
);

reportRoutes.get(
  '/collection',
  requireRole('ADMIN'),
  validate(collectionReportQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { from, to } = validatedQuery(req, collectionReportQuerySchema);
    const report = await service.getCollectionReport(from, to);

    if (req.query.format === 'csv') {
      sendCsv(
        res,
        csvFilename('collection', `${from}-to-${to}`),
        toCsv(
          [
            'Receipt',
            'Date',
            'Student ID',
            'Name',
            'Class',
            'Fee month',
            'Mode',
            'Reference',
            'Amount',
            // Without a status column, summing Amount in a spreadsheet would count a
            // bounced cheque as money received.
            'Status',
            'Reversed on',
            'Reversal reason',
          ],
          report.rows.map((row) => [
            row.receiptNo,
            row.paidAt,
            row.studentId,
            row.studentName,
            classLabel(row.classCode),
            row.period,
            row.mode,
            row.reference,
            rupeesForCsv(row.amountRupees),
            row.isReversed ? 'Reversed' : 'Received',
            row.reversedAt ?? '',
            row.reversalReason,
          ]),
        ),
      );
      return;
    }

    res.json(report);
  }),
);
