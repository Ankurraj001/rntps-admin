import { useMutation } from '@tanstack/react-query';
import { MessageCircle } from 'lucide-react';
import type { ExamCode } from '@rntps/shared';
import { academicsApi } from '@/api/academics';
import { Button } from '@/components/ui/Button';

/**
 * Sends a student's report card to WhatsApp, addressed to whichever guardian is reachable.
 *
 * Built server-side — guardian selection, template and message-length fitting — exactly
 * like the invoice button next door, so the two messages a parent gets from this school
 * are laid out by the same rules.
 *
 * The link isn't known until the API responds, so a blank tab is opened first and
 * redirected once the message is built. That keeps the tab tied to the actual click, which
 * is what stops browsers treating it as an unsolicited popup.
 */
export function WhatsAppReportCardButton({
  studentId,
  academicYear,
  exam,
  disabled = false,
  className,
}: {
  studentId: string;
  academicYear: string;
  /** Omitted sends the whole session; a code sends that one paper. */
  exam?: ExamCode;
  /** Set when the paper on screen has nothing to send. */
  disabled?: boolean;
  className?: string;
}) {
  const send = useMutation({
    mutationFn: () => academicsApi.reportCardWaLink(studentId, academicYear, exam),
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

  return (
    <Button
      variant="secondary"
      onClick={handleClick}
      disabled={disabled || send.isPending}
      className={className}
    >
      <MessageCircle className="h-4 w-4 text-emerald-600" aria-hidden />
      WhatsApp
    </Button>
  );
}
