import type { UserDto } from '@rntps/shared';

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1';

export interface ApiFieldError {
  field: string;
  message: string;
}

/** Carries the server's structured error through to the form that triggered it. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = 'ERROR',
    readonly fieldErrors: ApiFieldError[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The access token lives in memory only.
 *
 * localStorage would expose it to any XSS on the page and it would outlive the tab;
 * the long-lived credential is the httpOnly refresh cookie, which JavaScript cannot read.
 * A page reload therefore starts with no access token and recovers it via /auth/refresh.
 */
let accessToken: string | null = null;
let onAuthFailure: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Called when refreshing fails, so the app can drop back to the login screen. */
export function setAuthFailureHandler(handler: (() => void) | null): void {
  onAuthFailure = handler;
}

export interface SessionPayload {
  accessToken: string;
  expiresIn: number;
  user: UserDto;
}

/**
 * Single-flight refresh, shared by every caller: the bootstrap on page load, the
 * scheduled renewal, and the 401 retry below.
 *
 * Rotation means one refresh invalidates the previous token, so two concurrent refreshes
 * would make the second look like a replay. Several requests routinely 401 at the same
 * moment (a dashboard fires three at once) and React StrictMode double-invokes effects in
 * development, so without this the user gets signed out on nearly every page load.
 */
let refreshInFlight: Promise<SessionPayload | null> | null = null;

export async function refreshSession(): Promise<SessionPayload | null> {
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        accessToken = null;
        return null;
      }
      const data = (await response.json()) as SessionPayload;
      accessToken = data.accessToken;
      return data;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/** Endpoints that must never trigger a refresh-and-retry loop. */
function isAuthEndpoint(path: string): boolean {
  return path.startsWith('/auth/login') || path.startsWith('/auth/refresh') || path.startsWith('/auth/logout');
}

async function send(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(init.headers ?? {}),
    },
    credentials: 'include',
  });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await send(path, init);
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Is the API running?', 'NETWORK');
  }

  // One transparent refresh-and-retry when the access token has simply expired.
  if (response.status === 401 && !isAuthEndpoint(path)) {
    const renewed = await refreshSession();
    if (renewed) {
      try {
        response = await send(path, init);
      } catch {
        throw new ApiError(0, 'Cannot reach the server. Is the API running?', 'NETWORK');
      }
    } else {
      accessToken = null;
      onAuthFailure?.();
    }
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload as { error?: Record<string, unknown> } | null)?.error ?? {};
    throw new ApiError(
      response.status,
      (error.message as string) ?? `Request failed (${response.status})`,
      (error.code as string) ?? 'ERROR',
      Array.isArray(error.details) ? (error.details as ApiFieldError[]) : [],
    );
  }

  return payload as T;
}

/**
 * Fetches a non-JSON response (a CSV export) with the same auth and refresh-retry
 * behaviour as request(), since those endpoints are authenticated too.
 */
async function requestBlob(path: string): Promise<Blob> {
  let response = await send(path, {});

  if (response.status === 401) {
    const renewed = await refreshSession();
    if (renewed) response = await send(path, {});
    else {
      accessToken = null;
      onAuthFailure?.();
    }
  }

  if (!response.ok) {
    throw new ApiError(response.status, `Download failed (${response.status})`, 'DOWNLOAD_FAILED');
  }
  return response.blob();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  getBlob: (path: string) => requestBlob(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/** Builds a query string, dropping empty values so the URL stays readable. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : '';
}
