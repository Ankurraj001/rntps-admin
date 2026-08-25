import type {
  AuthConfigDto,
  LoginResponse,
  UpdateUserPayload,
  UserDto,
  CreateUserInput,
} from '@rntps/shared';
import { api } from '@/lib/api';

export interface TemporaryPasswordResult {
  user: UserDto;
  temporaryPassword: string | null;
}

export const authApi = {
  login: (email: string, password: string) =>
    api.post<LoginResponse>('/auth/login', { email, password }),
  refresh: () => api.post<LoginResponse>('/auth/refresh'),
  logout: () => api.post<void>('/auth/logout'),
  me: () => api.get<UserDto>('/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<void>('/auth/change-password', { currentPassword, newPassword }),
  config: () => api.get<AuthConfigDto>('/auth/config'),
  forgotPassword: (email: string) => api.post<void>('/auth/forgot-password', { email }),
  resetPassword: (token: string, newPassword: string) =>
    api.post<void>('/auth/reset-password', { token, newPassword }),
};

export const usersApi = {
  list: () => api.get<{ items: UserDto[] }>('/users'),
  create: (payload: CreateUserInput) => api.post<TemporaryPasswordResult>('/users', payload),
  update: (id: string, payload: UpdateUserPayload) => api.patch<UserDto>(`/users/${id}`, payload),
  deactivate: (id: string) => api.post<UserDto>(`/users/${id}/deactivate`),
  activate: (id: string) => api.post<UserDto>(`/users/${id}/activate`),
  unlock: (id: string) => api.post<UserDto>(`/users/${id}/unlock`),
  resetPassword: (id: string) =>
    api.post<TemporaryPasswordResult>(`/users/${id}/reset-password`, {}),
  /** Only works when the server is storing readable passwords; every call is audited. */
  revealPassword: (id: string) => api.get<{ password: string }>(`/users/${id}/password`),
};

export const userKeys = { all: ['users'] as const };
