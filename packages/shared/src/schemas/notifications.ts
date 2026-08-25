import { z } from 'zod';
import { CLASS_CODES } from '../constants.js';
import { PERIOD_PATTERN } from '../date.js';

export const NOTIFICATION_TYPES = ['FEE_DUE'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * Settings key for the monthly fee-demand template, replacing the older `FEE_DUE`.
 *
 * A new key rather than a new body under the old one: `seedSettings` leaves an existing
 * settings document untouched and there is no template editor in the UI, so a deployment
 * already holding a `FEE_DUE` row would otherwise be pinned to the old flat summary for
 * ever. A new key misses that row and falls through to the service default, so the
 * itemised format lands with no migration. The old row is left alone but no longer read.
 */
export const FEE_DEMAND_TEMPLATE_KEY = 'FEE_DEMAND';

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
 * Ceiling on a stored message template body.
 *
 * The runtime guard on an outgoing message is `MAX_WA_URL_LENGTH` below, which measures
 * the encoded URL — the thing that actually gets truncated. This one just stops a template
 * from being edited into something that could never fit.
 */
export const MAX_MESSAGE_LENGTH = 1500;

/** Fills {{placeholders}} in a template. Unknown placeholders are left visible so a broken template is obvious rather than silently blank. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] ?? '' : match,
  );
}

/**
 * Ceiling on the whole `wa.me` URL, not just the message.
 *
 * The percent-encoded text is what actually travels, and encoding is far from
 * length-preserving: every `₹` becomes `%E2%82%B9`, nine characters for one. So a message
 * measured in characters says little about the URL carrying it, and the URL is what
 * browsers and WhatsApp Web truncate.
 */
export const MAX_WA_URL_LENGTH = 4000;

export function waUrlFits(phone: string, message: string): boolean {
  return buildWaLink(phone, message).length <= MAX_WA_URL_LENGTH;
}

/** Re-closes a monospace fence that trimming left open. */
function balanceFence(lines: string[]): string[] {
  const isOpen = lines.filter((line) => line.trim() === '```').length % 2 === 1;
  return isOpen ? [...lines, '```'] : lines;
}

/**
 * Trims a message from the end until its `wa.me` URL fits, dropping whole lines.
 *
 * Whole lines rather than characters, and the fence is re-closed afterwards: an unclosed
 * ``` makes WhatsApp render the rest of the conversation as code, so a blindly sliced
 * fee slip is worse than a short one.
 */
export function fitWaMessage(phone: string, message: string): string {
  if (waUrlFits(phone, message)) return message;

  const lines = message.split('\n');
  while (lines.length > 1) {
    lines.pop();
    const trimmed = balanceFence(lines).join('\n');
    if (waUrlFits(phone, trimmed)) return trimmed;
  }
  return balanceFence(lines).join('\n');
}
