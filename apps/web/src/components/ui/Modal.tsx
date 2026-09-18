import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  /**
   * How wide the panel is. `md` suits a handful of fields; `lg` exists for the marks card,
   * which is forty-odd inputs and unreadable squeezed into a dialog meant for four.
   */
  size?: 'md' | 'lg';
  children: ReactNode;
}

const SIZES: Record<'md' | 'lg', string> = {
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

/**
 * A centred dialog over a scrim.
 *
 * The overlay behaviour is the same as the mobile navigation drawer in AppShell —
 * Escape dismisses it and the page behind must not scroll while it is open — because a
 * dialog the keyboard cannot close, over a page that scrolls out from under it, is the
 * usual way this component goes wrong.
 *
 * Focus moves to the panel on open so a screen reader lands inside the dialog rather
 * than at the top of the page it is covering.
 */
export function Modal({ open, onClose, title, description, size = 'md', children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    // Centred with auto margins rather than `items-center`, because a panel taller than
    // the viewport centred by alignment overflows in *both* directions and its top becomes
    // unreachable by scrolling. Auto margins collapse to zero once free space runs out.
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 print:hidden">
      <div className="absolute inset-0 bg-slate-900/50" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        className={cn(
          'relative my-auto w-full rounded-lg bg-white shadow-xl focus:outline-none',
          SIZES[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 id="modal-title" className="text-base font-semibold text-slate-900">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close" type="button">
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}
