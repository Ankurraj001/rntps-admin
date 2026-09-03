import type { InvoiceWaLinkDto, NotificationBatchDto, NotificationItemStatus } from '@rntps/shared';
import { api } from '@/lib/api';

export type BatchSummary = Omit<NotificationBatchDto, 'items' | 'unreachable'>;

export const notificationsApi = {
  list: () => api.get<{ items: BatchSummary[] }>('/notifications'),
  create: (payload: {
    period?: string;
    classCodes?: string[];
    minDueRupees?: number;
    overdueOnly?: boolean;
  }) => api.post<NotificationBatchDto>('/notifications', { type: 'FEE_DUE', ...payload }),
  get: (batchId: string) => api.get<NotificationBatchDto>(`/notifications/${batchId}`),
  setItemStatus: (batchId: string, itemKey: string, status: NotificationItemStatus) =>
    api.patch<NotificationBatchDto>(`/notifications/${batchId}/items/${itemKey}`, { status }),
  /** The same bill, addressed to whichever guardian is reachable — for the WhatsApp icon
   *  next to an invoice's Fee slip link. */
  invoiceWaLink: (invoiceId: string) =>
    api.get<InvoiceWaLinkDto>(`/notifications/invoices/${encodeURIComponent(invoiceId)}/whatsapp-link`),
};

export const notificationKeys = {
  all: ['notifications'] as const,
  batch: (id: string) => ['notifications', id] as const,
};
