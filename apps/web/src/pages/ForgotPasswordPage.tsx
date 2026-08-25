import { GraduationCap, KeyRound, MailCheck } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { authApi } from '@/api/auth';
import { Button } from '@/components/ui/Button';
import { Card, CardBody } from '@/components/ui/Card';
import { ErrorBlock, Spinner } from '@/components/ui/Feedback';
import { Field, Input } from '@/components/ui/Field';
import { ApiError } from '@/lib/api';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Whether a reset link can actually be delivered. Asked before anything is offered:
  // showing the form on a server with no SMTP credentials means promising an email that
  // never arrives, and the user waits for it instead of asking for help.
  const config = useQuery({ queryKey: ['auth', 'config'], queryFn: authApi.config, retry: false });
  const canEmailReset = config.data?.passwordResetByEmail ?? false;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await authApi.forgotPassword(email);
      setSubmitted(true);
    } catch (caught) {
      // A rate-limit response is worth showing; anything else the server treats as a
      // silent success, so there is nothing useful to say.
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
          <h1 className="text-lg font-semibold text-slate-900">Forgotten password</h1>
        </div>

        <Card>
          <CardBody>
            {config.isPending ? (
              <div className="py-6 text-center">
                <Spinner />
              </div>
            ) : !canEmailReset ? (
              <div className="space-y-3">
                <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
                  <KeyRound className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    Resetting your own password by email is not set up on this school's system.
                  </span>
                </div>
                <p className="text-sm text-slate-700">
                  Ask an administrator to set a new password for you. They can do it from{' '}
                  <strong>Settings → Users</strong>, and you will be asked to change it the first
                  time you sign in.
                </p>
                <p className="text-xs text-slate-500">
                  Administrators: <code>Settings → Users → Reset password</code>, or run{' '}
                  <code>npm run reset:password -- your@email</code> on the server.
                </p>
                <Link to="/login" className="inline-block pt-1 text-sm text-brand-700 underline">
                  Back to sign in
                </Link>
              </div>
            ) : submitted ? (
              <div className="space-y-3 text-center">
                <MailCheck className="mx-auto h-8 w-8 text-emerald-600" aria-hidden />
                <p className="text-sm font-medium text-slate-900">Check your email</p>
                {/* Deliberately vague about whether the address is registered — saying
                    otherwise would let anyone test which staff addresses exist. */}
                <p className="text-sm text-slate-600">
                  If <strong>{email}</strong> has an account, a reset link is on its way. The link
                  expires in an hour.
                </p>
                <p className="text-xs text-slate-500">
                  Nothing arrived? Check the spam folder, or ask an administrator to reset it for
                  you.
                </p>
                <Link to="/login" className="inline-block pt-2 text-sm text-brand-700 underline">
                  Back to sign in
                </Link>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                {error && <ErrorBlock message={error} />}

                <p className="text-sm text-slate-600">
                  Enter the email address you sign in with and we will send you a reset link.
                </p>

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

                <Button type="submit" className="w-full" disabled={isSubmitting || !email}>
                  {isSubmitting && <Spinner />}
                  Send reset link
                </Button>

                <Link to="/login" className="block text-center text-sm text-brand-700 underline">
                  Back to sign in
                </Link>
              </form>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
