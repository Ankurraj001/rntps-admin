import { PASSWORD_MIN_LENGTH } from '@rntps/shared';
import { GraduationCap } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { authApi } from '@/api/auth';
import { Button } from '@/components/ui/Button';
import { Card, CardBody } from '@/components/ui/Card';
import { ErrorBlock, Spinner } from '@/components/ui/Feedback';
import { Field, Input } from '@/components/ui/Field';
import { ApiError } from '@/lib/api';

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') ?? '';
  // Wording only. The server decides what the token actually authorises, so a tampered
  // `mode` changes nothing but the heading.
  const isInvite = searchParams.get('mode') === 'invite';

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const tooShort = newPassword.length > 0 && newPassword.length < PASSWORD_MIN_LENGTH;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (mismatch || tooShort) return;

    setError(null);
    setIsSubmitting(true);

    try {
      await authApi.resetPassword(token, newPassword);
      navigate('/login', { replace: true, state: { passwordReset: true } });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <GraduationCap className="h-9 w-9 text-brand-600" aria-hidden />
          <h1 className="text-lg font-semibold text-slate-900">
            {isInvite ? 'Set your password' : 'Set a new password'}
          </h1>
          {isInvite && (
            <p className="text-sm text-slate-600">
              Choose a password for your RNTPS Admin account. Nobody else can see it.
            </p>
          )}
        </div>

        <Card>
          <CardBody>
            {!token ? (
              <div className="space-y-3 text-center">
                <p className="text-sm text-slate-700">This link is missing its code.</p>
                <p className="text-sm text-slate-600">
                  Open the link from your email directly, or request a new one.
                </p>
                <Link to="/forgot-password" className="inline-block text-sm text-brand-700 underline">
                  Request a new link
                </Link>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                {error && <ErrorBlock message={error} />}

                <Field
                  label="New password"
                  htmlFor="next"
                  required
                  error={tooShort ? `Use at least ${PASSWORD_MIN_LENGTH} characters` : undefined}
                  hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short phrase you can remember beats a short jumble.`}
                >
                  <Input
                    id="next"
                    type="password"
                    autoComplete="new-password"
                    autoFocus
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

                <Button
                  type="submit"
                  className="w-full"
                  disabled={isSubmitting || mismatch || tooShort || !newPassword}
                >
                  {isSubmitting && <Spinner />}
                  Save password
                </Button>

                <p className="text-center text-xs text-slate-500">
                  You will be signed out everywhere and can sign in with the new password.
                </p>
              </form>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
