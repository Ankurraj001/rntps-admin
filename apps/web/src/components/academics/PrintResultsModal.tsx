import {
  DEFAULT_REPORT_SCOPE,
  REPORT_SCOPE_CODES,
  REPORT_SCOPE_LABELS,
  classLabel,
  type ReportScopeCode,
} from '@rntps/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { settingsApi, settingsKeys } from '@/api/settings';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';

/**
 * Chooses a class and a paper, then opens that whole class's cards ready to print.
 *
 * The session is not a third dropdown: it is whichever the gradebook behind the dialog is
 * already showing, stated rather than re-asked. Printing a different session from the one
 * on screen is not a thing anyone means to do, and an extra control invites exactly that
 * mistake on results day.
 */
export function PrintResultsModal({
  classes,
  academicYear,
  defaultClassCode,
  onClose,
}: {
  /** The classes this user may open — a teacher sees only their own. */
  classes: readonly string[];
  academicYear: string;
  defaultClassCode: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const settings = useQuery({ queryKey: settingsKeys.school, queryFn: settingsApi.school });
  const [classCode, setClassCode] = useState(defaultClassCode || (classes[0] ?? ''));

  /*
    Null until the admin picks one, resolved on every render rather than seeded into state.

    The dialog opens on whichever paper the school has configured, and that may still be
    in flight when it mounts — a `useState` seeded from it would keep whatever was known
    at that instant and never pick up the answer.
  */
  const [exam, setExam] = useState<ReportScopeCode | null>(null);
  const selected = exam ?? settings.data?.defaultReportScope ?? DEFAULT_REPORT_SCOPE;

  function handlePrint() {
    // Always sent, including for the whole session: the page it opens reads a missing
    // parameter as the school's default rather than as all six papers.
    const query = new URLSearchParams({ classCode, exam: selected });
    navigate(`/academics/report-cards/${encodeURIComponent(academicYear)}?${query.toString()}`);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Print results"
      description={`One card per student, for ${academicYear}.`}
    >
      <div className="space-y-4 px-5 py-4">
        <Field label="Class" htmlFor="print-class">
          <Select
            id="print-class"
            value={classCode}
            onChange={(event) => setClassCode(event.target.value)}
          >
            {classes.map((code) => (
              <option key={code} value={code}>
                {classLabel(code)}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Exam"
          htmlFor="print-exam"
          hint="A paper nobody has sat yet prints as dashes."
        >
          <Select
            id="print-exam"
            value={selected}
            onChange={(event) => setExam(event.target.value as ReportScopeCode)}
          >
            {REPORT_SCOPE_CODES.map((code) => (
              <option key={code} value={code}>
                {REPORT_SCOPE_LABELS[code]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" onClick={handlePrint} disabled={!classCode}>
          Open cards
        </Button>
      </div>
    </Modal>
  );
}
