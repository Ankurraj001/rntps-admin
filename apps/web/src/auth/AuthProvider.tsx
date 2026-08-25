import type { UserDto } from '@rntps/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { authApi } from '@/api/auth';
import { refreshSession, setAccessToken, setAuthFailureHandler } from '@/lib/api';

interface AuthState {
  user: UserDto | null;
  /** True until the initial refresh attempt settles, so routes do not flash the login page. */
  isBootstrapping: boolean;
  signIn: (email: string, password: string) => Promise<UserDto>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const queryClient = useQueryClient();
  const renewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSession = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    if (renewTimer.current) clearTimeout(renewTimer.current);
    queryClient.clear();
  }, [queryClient]);

  /**
   * Renews shortly before the access token expires, so a user filling in a long
   * onboarding form is not interrupted by a failed save.
   */
  const scheduleRenewal = useCallback((expiresIn: number) => {
    if (renewTimer.current) clearTimeout(renewTimer.current);
    const delay = Math.max(30_000, (expiresIn - 60) * 1000);
    renewTimer.current = setTimeout(() => {
      void refreshSession().then((session) => {
        if (!session) {
          clearSession();
          return;
        }
        setUser(session.user);
        scheduleRenewal(session.expiresIn);
      });
    }, delay);
  }, [clearSession]);

  // On load there is no access token — only the httpOnly refresh cookie. This exchanges
  // it for a session, which is what keeps the user signed in across a page reload.
  useEffect(() => {
    let cancelled = false;

    void refreshSession()
      .then((session) => {
        if (cancelled || !session) return;
        setUser(session.user);
        scheduleRenewal(session.expiresIn);
      })
      .finally(() => {
        if (!cancelled) setIsBootstrapping(false);
      });

    return () => {
      cancelled = true;
    };
  }, [scheduleRenewal]);

  // A failed refresh mid-session drops straight back to the login screen.
  useEffect(() => {
    setAuthFailureHandler(clearSession);
    return () => setAuthFailureHandler(null);
  }, [clearSession]);

  useEffect(() => () => {
    if (renewTimer.current) clearTimeout(renewTimer.current);
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const session = await authApi.login(email, password);
      setAccessToken(session.accessToken);
      setUser(session.user);
      scheduleRenewal(session.expiresIn);
      return session.user;
    },
    [scheduleRenewal],
  );

  const signOut = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      // Sign-out must succeed locally even if the request fails.
      clearSession();
    }
  }, [clearSession]);

  const refreshUser = useCallback(async () => {
    setUser(await authApi.me());
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, isBootstrapping, signIn, signOut, refreshUser }),
    [user, isBootstrapping, signIn, signOut, refreshUser],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  const context = use(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

export function useCurrentUser(): UserDto {
  const { user } = useAuth();
  if (!user) throw new Error('useCurrentUser used outside an authenticated route');
  return user;
}
