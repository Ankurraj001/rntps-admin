import { z } from 'zod';
import { CLASS_CODES } from '../constants.js';
import { PERIOD_PATTERN } from '../date.js';

export const NOTIFICATION_TYPES = ['FEE_DUE'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_ITEM_STATUSES = ['PENDING', 'OPENED', 'SENT', 'SKIPPED'] as const;
export type NotificationItemStatus = (typeof NOTIFICATION_ITEM_STATUSES)[number];

export const createBatchSchema = z.object({
  type: z.enum(NOTIFICATION_TYPES).default('FEE_DUE'),
  /** Omit to include every unpaid period. */
  period: z.string().regex(PERIOD_PATTERN, 'Use the form 2026-08').optional(),
  classCodes: z.array(z.enum(CLASS_CODES)).min(1).optional(),
  /** Skip trivial balances, e.g. only chase families owing at least this much. */
  minDueRupees: z.coerce.number().int().min(0).default(1),
  /** Only families whose invoices are past the due date. */
  overdueOnly: z.boolean().default(false),
});

export const updateItemStatusSchema = z.object({
  status: z.enum(NOTIFICATION_ITEM_STATUSES),
});

export type CreateBatchPayload = z.output<typeof createBatchSchema>;

export interface NotificationItemDto {
  key: string;
  guardianName: string;
  guardianPhone: string;
  familyIds: string[];
  students: { studentId: string; fullName: string; classCode: string; dueRupees: number }[];
  invoiceIds: string[];
  totalDueRupees: number;
  renderedMessage: string;
  waLink: string;
  status: NotificationItemStatus;
  sentAt: string | null;
}

export interface NotificationBatchDto {
  id: string;
  type: NotificationType;
  createdAt: string;
  filter: { period?: string; classCodes?: string[]; minDueRupees: number; overdueOnly: boolean };
  totalCount: number;
  sentCount: number;
  skippedCount: number;
  items: NotificationItemDto[];
  /** Students whose guardian cannot be reached, so nothing could be built for them. */
  unreachable: { studentId: string; fullName: string; classCode: string; reason: string }[];
}

/**
 * Builds a wa.me click-to-chat URL.
 *
 * wa.me carries text only — no attachments — so the fee breakdown has to live in the
 * message body. The number must be digits with a country code and no "+", and the text
 * must be percent-encoded.
 */
export function buildWaLink(phone: string, message: string): string {
  const digits = phone.replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

/**
 * wa.me has no documented limit, but very long URLs get truncated by browsers and by
 * WhatsApp itself. Keeping the body well under this leaves room for the encoded overhead.
 */
export const MAX_MESSAGE_LENGTH = 1500;

/** Fills {{placeholders}} in a template. Unknown placeholders are left visible so a broken template is obvious rather than silently blank. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] ?? '' : match,
  );
}
