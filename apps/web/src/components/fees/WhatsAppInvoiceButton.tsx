import { useMutation } from '@tanstack/react-query';
import { MessageCircle } from 'lucide-react';
import { notificationsApi } from '@/api/notifications';
import { Button } from '@/components/ui/Button';

/**
 * Sends this invoice's bill to WhatsApp, addressed to whichever guardian is reachable —
 * built server-side (guardian selection, template, message-length fitting) exactly like a
 * bulk fee-demand run, just for this one invoice rather than a whole filtered batch.
 *
 * The link isn't known until the API responds, so it can't be opened the way the bulk
 * notifications queue does (where the link is already sitting in a loaded batch and
 * `window.open` runs synchronously in the click handler). Opening a blank tab first and
 * redirecting it once the message is built keeps the tab tied to the actual click, so
 * browsers don't block it as an unsolicited popup.
 */
export function WhatsAppInvoiceButton({
  invoiceId,
  iconOnly = false,
  className,
}: {
  invoiceId: string;
  iconOnly?: boolean;
  className?: string;
}) {
  const send = useMutation({
    mutationFn: () => notificationsApi.invoiceWaLink(invoiceId),
  });

  function handleClick() {
    const tab = window.open('', '_blank');
    send.mutate(undefined, {
      onSuccess: (result) => {
        if (tab) tab.location.href = result.waLink;
      },
      onError: (error) => {
        tab?.close();
        window.alert((error as Error).message);
      },
    });
  }

  if (iconOnly) {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={send.isPending}
        className={className ?? 'shrink-0 text-emerald-600 hover:text-emerald-700 disabled:opacity-50'}
        aria-label="Send this bill on WhatsApp"
        title="Send on WhatsApp"
      >
        <MessageCircle className="h-4 w-4" aria-hidden />
      </button>
    );
  }

  return (
    <Button variant="secondary" onClick={handleClick} disabled={send.isPending} className={className}>
      <MessageCircle className="h-4 w-4 text-emerald-600" aria-hidden />
      WhatsApp
    </Button>
  );
}
