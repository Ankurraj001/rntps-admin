import { GraduationCap } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { Card, CardBody } from '@/components/ui/Card';
import { ErrorBlock, Spinner } from '@/components/ui/Feedback';
import { Field, Input } from '@/components/ui/Field';
import { ApiError } from '@/lib/api';

export function LoginPage() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (user) return <Navigate to={user.mustChangePassword ? '/change-password' : '/'} replace />;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const signedIn = await signIn(email, password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(signedIn.mustChangePassword ? '/change-password' : (from ?? '/'), { replace: true });
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <GraduationCap className="h-9 w-9 text-brand-600" aria-hidden />
          <h1 className="text-lg font-semibold text-slate-900">RNTPS Admin</h1>
          <p className="text-sm text-slate-500">Sign in to continue</p>
        </div>

        <Card>
          <CardBody>
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              {error && <ErrorBlock message={error} />}

              {/* Set by the change-password and reset-password flows, both of which end
                  by revoking every session and sending the user back here. */}
              {(location.state as { passwordChanged?: boolean; passwordReset?: boolean } | null)
                ?.passwordChanged && (
                <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                  Password changed. Sign in with your new password.
                </p>
              )}
              {(location.state as { passwordReset?: boolean } | null)?.passwordReset && (
                <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                  Password reset. Sign in with your new password.
                </p>
              )}

              <Field label="Email" htmlFor="email" required>
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  autoFocus
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>

              <Field label="Password" htmlFor="password" required>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>

              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting && <Spinner />}
                Sign in
              </Button>
            </form>
          </CardBody>
        </Card>

        <p className="mt-4 text-center text-sm">
          <Link to="/forgot-password" className="text-brand-700 underline">
            Forgotten your password?
          </Link>
        </p>
      </div>
    </div>
  );
}
