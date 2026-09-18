import { EXAM_CODES, EXAM_LABELS, classLabel } from '@rntps/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
  const [classCode, setClassCode] = useState(defaultClassCode || (classes[0] ?? ''));
  const [exam, setExam] = useState('');

  function handlePrint() {
    const query = new URLSearchParams({ classCode });
    if (exam) query.set('exam', exam);
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
          <Select id="print-exam" value={exam} onChange={(event) => setExam(event.target.value)}>
            <option value="">Full session</option>
            {EXAM_CODES.map((code) => (
              <option key={code} value={code}>
                {EXAM_LABELS[code]}
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
