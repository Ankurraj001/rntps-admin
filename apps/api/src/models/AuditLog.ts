import { Schema, model, type Types } from 'mongoose';

export interface AuditLogDoc {
  _id: Types.ObjectId;
  actorId: string | null;
  actorName: string;
  action: string;
  entity: string;
  entityId: string;
  before: unknown;
  after: unknown;
  ip: string;
  at: Date;
}

/**
 * Append-only trail of every mutation. ObjectId is monotonic, so sorting by _id sorts
 * by time without a second index.
 */
const auditLogSchema = new Schema<AuditLogDoc>(
  {
    actorId: { type: String, default: null },
    actorName: { type: String, default: 'system' },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: { type: String, required: true },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: '' },
    at: { type: Date, default: () => new Date() },
  },
  { versionKey: false, strict: true },
);

auditLogSchema.index({ entity: 1, entityId: 1, at: -1 });
auditLogSchema.index({ actorId: 1, at: -1 });
// Two-year retention, in line with the data-minimisation stance in the README.
auditLogSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 730 });

export const AuditLog = model<AuditLogDoc>('AuditLog', auditLogSchema);
