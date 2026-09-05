import {
  buildWaLink,
  classLabel,
  fitWaMessage,
  type AttendanceStatus,
  type RosterEntry,
} from '@rntps/shared';
import { MessageCircle } from 'lucide-react';
import { formatDate } from '@/lib/utils';

/**
 * Where the daily absentee list goes. A single school office number rather than a per-user
 * setting: the report is the same for every class and every teacher, so there is nothing to
 * choose. Stored with the country code and no "+", the way every other number in the system is.
 */
const OFFICE_WHATSAPP = '918863905424';

/**
 * Builds the absentee report for one class on one day.
 *
 * Reads the marks currently on screen, not what was last saved, so the message always
 * matches what the person is looking at. `fitWaMessage` trims from the end if a very large
 * class would push the encoded URL past what WhatsApp accepts.
 */
export function absenteeMessage(
  entries: RosterEntry[],
  marks: Record<string, AttendanceStatus>,
  classCode: string,
  dateKey: string,
): string {
  const absent = entries.filter((entry) => marks[entry.studentId] === 'ABSENT');
  const heading = `*Absent students*\n${classLabel(classCode)} · ${formatDate(dateKey)}`;

  // A holiday has nobody absent, but reporting that as "all students present" tells the
  // office the school ran a full day. Checked before the empty case, which it would
  // otherwise fall into.
  if (entries.length > 0 && entries.every((entry) => marks[entry.studentId] === 'HOLIDAY')) {
    return `${heading}\n\nHoliday — the school was closed.`;
  }

  if (absent.length === 0) {
    return `${heading}\n\nNobody absent — all students present.`;
  }

  const list = absent
    .map((entry, index) => `${index + 1}. ${entry.fullName}${entry.rollNo == null ? '' : ` (Roll ${entry.rollNo})`}`)
    .join('\n');

  return `${heading}\n\n${list}`;
}

/**
 * Sends the class's absentee list to the school office on WhatsApp.
 *
 * Only offered once the day's attendance has actually been saved — before that the roster is
 * just the everyone-is-present default, and a report built from it would be a guess.
 *
 * Available to teachers and admins alike — it only reports the roster already in front of
 * them, so there is no data here a teacher cannot see. Everything is built client-side from
 * state, so `window.open` runs synchronously inside the click handler and browsers treat it
 * as a user gesture rather than a popup.
 */
export function WhatsAppAbsenteesButton({
  entries,
  marks,
  classCode,
  dateKey,
  disabled = false,
}: {
  entries: RosterEntry[];
  marks: Record<string, AttendanceStatus>;
  classCode: string;
  dateKey: string;
  disabled?: boolean;
}) {
  function handleClick() {
    const message = fitWaMessage(OFFICE_WHATSAPP, absenteeMessage(entries, marks, classCode, dateKey));
    window.open(buildWaLink(OFFICE_WHATSAPP, message), '_blank', 'noopener,noreferrer');
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      aria-label="Send the absentee list on WhatsApp"
      title="Send absentees on WhatsApp"
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-300 bg-white text-emerald-600 transition-colors hover:bg-emerald-50 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <MessageCircle className="h-4 w-4" aria-hidden />
    </button>
  );
}
