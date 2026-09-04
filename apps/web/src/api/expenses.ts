import type { CreateExpensePayload, ExpenseDto, ExpenseMonthDto } from '@rntps/shared';
import { api, qs } from '@/lib/api';

/** What the API reports back after trying to email a month's expenses. */
export interface ExpenseEmailResult {
  /** False when no recipient is configured, so nothing was attempted. */
  attempted: boolean;
  sent: boolean;
  error?: string;
  month: string;
  rowCount: number;
  totalRupees: number;
}

export const expensesApi = {
  month: (month: string) => api.get<ExpenseMonthDto>(`/expenses${qs({ month })}`),
  add: (payload: CreateExpensePayload) => api.post<ExpenseDto>('/expenses', payload),
  remove: (id: string) => api.del<{ deleted: boolean }>(`/expenses/${id}`),
  email: (month: string) => api.post<ExpenseEmailResult>('/expenses/email', { month }),
};

export const expenseKeys = {
  all: ['expenses'] as const,
  month: (month: string) => ['expenses', month] as const,
};
