import type { InvoiceWaLinkDto, NotificationBatchDto, NotificationItemStatus } from '@rntps/shared';
import { api, qs } from '@/lib/api';

export type BatchSummary = Omit<NotificationBatchDto, 'items' | 'unreachable'>;

export const notificationsApi = {
  /** `month` is the IST month a batch was built in; blank lists every month. */
  list: (month?: string) => api.get<{ items: BatchSummary[] }>(`/notifications${qs({ month })}`),
  create: (payload: {
    period?: string;
    classCodes?: string[];
    minDueRupees?: number;
    overdueOnly?: boolean;
  }) => api.post<NotificationBatchDto>('/notifications', { type: 'FEE_DUE', ...payload }),
  get: (batchId: string) => api.get<NotificationBatchDto>(`/notifications/${batchId}`),
  remove: (batchId: string) => api.del<{ deleted: boolean }>(`/notifications/${batchId}`),
  setItemStatus: (batchId: string, itemKey: string, status: NotificationItemStatus) =>
    api.patch<NotificationBatchDto>(`/notifications/${batchId}/items/${itemKey}`, { status }),
  /** The same bill, addressed to whichever guardian is reachable — for the WhatsApp icon
   *  next to an invoice's Fee slip link. */
  invoiceWaLink: (invoiceId: string) =>
    api.get<InvoiceWaLinkDto>(`/notifications/invoices/${encodeURIComponent(invoiceId)}/whatsapp-link`),
};

export const notificationKeys = {
  /** Prefix for the lot — invalidating this catches every month's list and every batch. */
  all: ['notifications'] as const,
  list: (month: string) => ['notifications', 'list', month] as const,
  batch: (id: string) => ['notifications', id] as const,
};
