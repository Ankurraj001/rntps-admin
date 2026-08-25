import type { UserRole } from '@rntps/shared';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { LoadingBlock } from '@/components/ui/Feedback';

/**
 * Gate for every authenticated route.
 *
 * Waits for the initial refresh before deciding: without that, a page reload would
 * bounce a signed-in user to the login screen for a moment before recovering.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isBootstrapping } = useAuth();
  const location = useLocation();

  if (isBootstrapping) return <LoadingBlock label="Signing you in…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  // A temporary password gets you exactly one place: the change-password screen.
  if (user.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }

  return <>{children}</>;
}

/**
 * Client-side role gate. Convenience only — the API enforces the same rule, so a user
 * who edits their way past this still gets a 403.
 */
export function RequireRole({ role, children }: { role: UserRole; children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to="/" replace />;
  return <>{children}</>;
}
