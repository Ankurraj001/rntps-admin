import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';

export function NotFoundPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-10 text-center">
      <p className="text-lg font-semibold text-slate-900">Page not found</p>
      <p className="text-sm text-slate-500">That link does not point anywhere in the admin app.</p>
      <Link to="/">
        <Button variant="secondary">Back to dashboard</Button>
      </Link>
    </div>
  );
}
