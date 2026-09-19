import {
  DEFAULT_REPORT_SCOPE,
  REPORT_SCOPE_CODES,
  type ReportScopeCode,
} from '@rntps/shared';
import { Schema, model, type HydratedDocument } from 'mongoose';

export const SETTINGS_ID = 'app';

export interface SettingsDoc {
  _id: string;
  schoolName: string;
  schoolAddress: string;
  schoolPhone: string;
  activeAcademicYear: string;
  studentIdPrefix: string;
  feeDueDayOfMonth: number;
  /**
   * Which paper a report card opens on, `ALL` being the whole session.
   *
   * Absent on a settings document written before this existed, which is why every reader
   * falls back to `DEFAULT_REPORT_SCOPE` rather than trusting the model default — a
   * default only applies when a document is created, and this one already exists.
   */
  defaultReportScope: ReportScopeCode;
  counters: { student: number; receipt: number; family: number };
  holidays: { dateKey: string; label: string }[];
  templates: { key: string; name: string; body: string; isActive: boolean }[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A single document (`_id: "app"`) holding what would otherwise be four collections:
 * academic year, ID counters, the holiday calendar and message templates.
 */
const settingsSchema = new Schema<SettingsDoc>(
  {
    _id: { type: String, default: SETTINGS_ID },
    schoolName: { type: String, default: 'RNTPS', trim: true },
    schoolAddress: { type: String, default: '', trim: true },
    schoolPhone: { type: String, default: '', trim: true },
    activeAcademicYear: { type: String, required: true },
    studentIdPrefix: { type: String, default: 'RNTPS', uppercase: true, trim: true },
    feeDueDayOfMonth: { type: Number, default: 10, min: 1, max: 28 },
    defaultReportScope: {
      type: String,
      enum: REPORT_SCOPE_CODES,
      default: DEFAULT_REPORT_SCOPE,
    },
    counters: {
      student: { type: Number, default: 0, min: 0 },
      receipt: { type: Number, default: 0, min: 0 },
      family: { type: Number, default: 0, min: 0 },
    },
    holidays: {
      type: [{ _id: false, dateKey: { type: String, required: true }, label: { type: String, required: true } }],
      default: [],
    },
    templates: {
      type: [
        {
          _id: false,
          key: { type: String, required: true },
          name: { type: String, required: true },
          body: { type: String, required: true },
          isActive: { type: Boolean, default: true },
        },
      ],
      default: [],
    },
  },
  { timestamps: true, versionKey: false, _id: false },
);

export const Settings = model<SettingsDoc>('Settings', settingsSchema);
export type SettingsHydrated = HydratedDocument<SettingsDoc>;
