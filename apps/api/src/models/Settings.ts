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
