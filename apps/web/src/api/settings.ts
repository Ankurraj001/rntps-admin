import type { SettingsDto, UpdateSettingsPayload } from '@rntps/shared';
import { api } from '@/lib/api';

export const settingsApi = {
  get: () => api.get<SettingsDto>('/settings'),
  update: (payload: UpdateSettingsPayload) => api.patch<SettingsDto>('/settings', payload),
};

export const settingsKeys = { all: ['settings'] as const };
