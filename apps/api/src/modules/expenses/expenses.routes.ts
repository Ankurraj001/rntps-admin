import { createExpenseSchema, expensesQuerySchema } from '@rntps/shared';
import { Router } from 'express';
import { AppError } from '../../lib/AppError.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { recordAudit } from '../../lib/audit.js';
import { currentUser, requireAuth, requireRole } from '../../middleware/auth.js';
import { validate, validatedBody, validatedQuery } from '../../middleware/validate.js';
import { sendMonthlyExpenseReport } from './expensesMail.js';
import * as service from './expenses.service.js';

export const expenseRoutes = Router();

// What the school spends is not a teacher's business.
expenseRoutes.use(requireAuth(), requireRole('ADMIN'));

expenseRoutes.get(
  '/',
  validate(expensesQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { month } = validatedQuery(req, expensesQuerySchema);
    res.json(await service.getMonth(month));
  }),
);

/**
 * Emails the selected month's expenses on demand, to the same `DAILY_REPORT_TO` list the
 * month-end schedule uses. Sends the month exactly as it stands right now.
 *
 * Answers 200 with `sent: false` rather than an error status when the mail fails, because
 * "no recipient configured" and "the transport refused it" are different things the person
 * who pressed the button needs told apart — an error status would flatten both into a
 * generic failure.
 */
expenseRoutes.post(
  '/email',
  // Same single `month` field as the list query, so it validates against the same schema.
  validate(expensesQuerySchema),
  asyncHandler(async (req, res) => {
    const { month } = validatedBody(req, expensesQuerySchema);
    const result = await sendMonthlyExpenseReport({ month });

    await recordAudit(req, {
      action: 'expense-report.email',
      entity: 'expense',
      entityId: month,
      after: { sent: result.sent, rowCount: result.rowCount, totalRupees: result.totalRupees },
    });

    res.json(result);
  }),
);

expenseRoutes.post(
  '/',
  validate(createExpenseSchema),
  asyncHandler(async (req, res) => {
    const payload = validatedBody(req, createExpenseSchema);
    const expense = await service.createExpense(payload, currentUser(req).id);

    await recordAudit(req, {
      action: 'expense.create',
      entity: 'expense',
      entityId: expense.id,
      after: { dateKey: expense.dateKey, name: expense.name, amountRupees: expense.amountRupees },
    });

    res.status(201).json(expense);
  }),
);

expenseRoutes.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const removed = await service.deleteExpense(String(req.params.id));
    if (!removed) throw new AppError(404, 'Expense not found', 'EXPENSE_NOT_FOUND');

    // `before` carries the whole record, not just its id: this is a hard delete, so once
    // the document is gone this log line is the only remaining trace that it existed.
    await recordAudit(req, {
      action: 'expense.delete',
      entity: 'expense',
      entityId: removed.id,
      before: { dateKey: removed.dateKey, name: removed.name, amountRupees: removed.amountRupees },
    });

    res.json({ deleted: true });
  }),
);
