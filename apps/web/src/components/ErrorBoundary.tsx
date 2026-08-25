import { AlertOctagon } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors that would otherwise leave a blank white page with the
 * failure only visible in the browser console — which a school office would report as
 * "the site is broken" with nothing actionable attached.
 *
 * Hook into a reporting service here (Sentry's `captureException`, or a POST to your own
 * endpoint) if you want these off the user's machine; the component works without one.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept as console rather than a silent swallow, so the stack survives in the browser
    // console and in any error-reporting integration added later.
    console.error('Unhandled render error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="w-full max-w-md rounded-lg border border-red-200 bg-white p-6 text-center shadow-sm">
          <AlertOctagon className="mx-auto h-8 w-8 text-red-600" aria-hidden />
          <h1 className="mt-3 text-lg font-semibold text-slate-900">Something went wrong</h1>
          <p className="mt-1 text-sm text-slate-600">
            The page could not be displayed. Your data has not been affected.
          </p>

          <pre className="mt-4 max-h-32 overflow-auto rounded bg-slate-50 p-3 text-left text-xs text-slate-600">
            {error.message}
          </pre>

          <div className="mt-4 flex justify-center gap-2">
            <Button onClick={() => this.setState({ error: null })} variant="secondary">
              Try again
            </Button>
            <Button onClick={() => window.location.assign('/')}>Back to dashboard</Button>
          </div>
        </div>
      </div>
    );
  }
}
