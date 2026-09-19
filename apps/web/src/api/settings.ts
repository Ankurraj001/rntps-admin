import type { SchoolInfoDto, SettingsDto, UpdateSettingsPayload } from '@rntps/shared';
import { api } from '@/lib/api';

export const settingsApi = {
  /** Admin only — carries the ID prefix and the school's counters alongside the letterhead. */
  get: () => api.get<SettingsDto>('/settings'),
  /**
   * The letterhead alone, readable by any signed-in user.
   *
   * What a printed document needs. Teachers print their own class's report cards, so those
   * pages ask for this rather than `get` above, which would 403 for them.
   */
  school: () => api.get<SchoolInfoDto>('/settings/school'),
  update: (payload: UpdateSettingsPayload) => api.patch<SettingsDto>('/settings', payload),
};

export const settingsKeys = {
  all: ['settings'] as const,
  school: ['settings', 'school'] as const,
};
