import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { authApi } from '@/api/auth';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { ErrorBlock, Spinner } from '@/components/ui/Feedback';
import { Field, Input } from '@/components/ui/Field';
import { ApiError } from '@/lib/api';

const MIN_LENGTH = 12;

export function ChangePasswordPage() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!user) return <Navigate to="/login" replace />;

  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const tooShort = newPassword.length > 0 && newPassword.length < MIN_LENGTH;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (mismatch || tooShort) return;

    setError(null);
    setIsSubmitting(true);

    try {
      await authApi.changePassword(currentPassword, newPassword);
      // The server revoked every session, including this one, so sign in again.
      await signOut();
      navigate('/login', { replace: true, state: { passwordChanged: true } });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md">
        <Card>
          <CardHeader
            title={user.mustChangePassword ? 'Set your password' : 'Change password'}
            description={
              user.mustChangePassword
                ? 'You are signed in with a temporary password. Choose your own to continue.'
                : 'You will be signed out of every device afterwards.'
            }
          />
          <CardBody>
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              {error && <ErrorBlock message={error} />}

              <Field label={user.mustChangePassword ? 'Temporary password' : 'Current password'} htmlFor="current" required>
                <Input
                  id="current"
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  required
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </Field>

              <Field
                label="New password"
                htmlFor="next"
                required
                error={tooShort ? `Use at least ${MIN_LENGTH} characters` : undefined}
                hint={`At least ${MIN_LENGTH} characters. A short phrase you can remember beats a short jumble.`}
              >
                <Input
                  id="next"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </Field>

              <Field
                label="Confirm new password"
                htmlFor="confirm"
                required
                error={mismatch ? 'Passwords do not match' : undefined}
              >
                <Input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </Field>

              <div className="flex justify-end gap-2 pt-1">
                {!user.mustChangePassword && (
                  <Button type="button" variant="secondary" onClick={() => navigate(-1)}>
                    Cancel
                  </Button>
                )}
                <Button type="submit" disabled={isSubmitting || mismatch || tooShort}>
                  {isSubmitting && <Spinner />}
                  Save password
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
