import {
  NOTIFICATION_ITEM_STATUSES,
  NOTIFICATION_TYPES,
  type NotificationItemStatus,
  type NotificationType,
} from '@rntps/shared';
import { Schema, model, type Types } from 'mongoose';

export interface NotificationItemSub {
  /** Stable identifier for the item within a batch — the guardian's phone number. */
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
  sentAt: Date | null;
  sentBy: string | null;
}

export interface NotificationDoc {
  _id: Types.ObjectId;
  type: NotificationType;
  createdBy: string;
  filterSnapshot: {
    period?: string;
    classCodes?: string[];
    minDueRupees: number;
    overdueOnly: boolean;
  };
  totalCount: number;
  items: NotificationItemSub[];
  unreachable: { studentId: string; fullName: string; classCode: string; reason: string }[];
  createdAt: Date;
  updatedAt: Date;
}

const itemSchema = new Schema<NotificationItemSub>(
  {
    key: { type: String, required: true },
    guardianName: { type: String, required: true },
    guardianPhone: { type: String, required: true },
    familyIds: { type: [String], default: [] },
    students: {
      type: [
        {
          _id: false,
          studentId: { type: String, required: true },
          fullName: { type: String, required: true },
          classCode: { type: String, required: true },
          dueRupees: { type: Number, required: true },
        },
      ],
      default: [],
    },
    invoiceIds: { type: [String], default: [] },
    totalDueRupees: { type: Number, required: true },
    // The message is stored as rendered, so the record shows exactly what was sent even
    // if the template changes afterwards.
    renderedMessage: { type: String, required: true },
    waLink: { type: String, required: true },
    status: { type: String, enum: NOTIFICATION_ITEM_STATUSES, default: 'PENDING' },
    sentAt: { type: Date, default: null },
    sentBy: { type: String, default: null },
  },
  { _id: false },
);

/**
 * Items are embedded rather than a separate collection: a batch is at most a couple of
 * hundred small entries, and progress updates are then single-document writes — which is
 * what makes a resumable queue work without transactions.
 */
const notificationSchema = new Schema<NotificationDoc>(
  {
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    createdBy: { type: String, required: true },
    filterSnapshot: {
      period: { type: String },
      classCodes: { type: [String] },
      minDueRupees: { type: Number, default: 1 },
      overdueOnly: { type: Boolean, default: false },
    },
    totalCount: { type: Number, required: true },
    items: { type: [itemSchema], default: [] },
    unreachable: {
      type: [
        {
          _id: false,
          studentId: String,
          fullName: String,
          classCode: String,
          reason: String,
        },
      ],
      default: [],
    },
  },
  { timestamps: true, versionKey: false },
);

notificationSchema.index({ createdAt: -1 });

export const Notification = model<NotificationDoc>('Notification', notificationSchema);
