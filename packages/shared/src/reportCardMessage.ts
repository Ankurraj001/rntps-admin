/**
 * Layout for the WhatsApp report card — the message a parent gets with their child's
 * marks, built to read like the printed card the school hands out.
 *
 * Pure, for the same reason `feeMessage.ts` is: it takes marks and returns a string, with
 * no database and no settings lookup, so the alignment arithmetic is unit-testable. A
 * column that drifts by one character is obvious to a parent and invisible in review.
 *
 * One block per paper rather than one grid for all six. A six-column grid cannot fit the
 * 26 characters WhatsApp will render without wrapping, and a wrapped row puts marks under
 * the wrong heading — which is worse than saying the same thing six times.
 */

import {
  EXAM_CODES,
  EXAM_LABELS,
  GRADED_SUBJECT_CODES,
  MAX_SUBJECT_MARK,
  SUBJECT_LABELS,
  classLabel,
  type ExamCode,
} from './constants.js';
import {
  examTotal,
  hasPaperContent,
  type CardGuardian,
  type ExamCardContent,
  type ExamScores,
  type ExamSubjectGrades,
  type ExamSubjectMarks,
} from './schemas/academics.js';

/**
 * Width of the marks table, in monospace characters. Matches the fee slip's `TABLE_WIDTH`
 * for the same reason it was chosen there: it fits the narrowest phone still in use.
 */
export const REPORT_TABLE_WIDTH = 26;

/**
 * Rules are ASCII, exactly as the fee slip's are, and for the same reason: a box-drawing
 * `─` costs nine characters once percent-encoded into a `wa.me` URL, so one 26-wide rule
 * would spend 234 characters of a budget a full six-paper card already overruns.
 */
const THIN_RULE = '-'.repeat(REPORT_TABLE_WIDTH);
const THICK_RULE = '='.repeat(REPORT_TABLE_WIDTH);
const FENCE = '```';

export interface ReportCardInput extends ExamCardContent {
  schoolName: string;
  schoolAddress?: string | null;
  fullName: string;
  /** Named on the card, as on the printed one. */
  guardian?: CardGuardian | null;
  rollNo: number | null;
  academicYear: string;
  /** Marks, grades and stored percentages come from ExamCardContent. */
  subjectMarks: ExamSubjectMarks;
  subjectGrades: ExamSubjectGrades;
  scores: ExamScores;
}

/**
 * Which papers a card covers: one, or all of them.
 *
 * `null` is the whole session. A single paper narrows every part of the message — heading,
 * blocks and the compact fallback — so one scope value drives the lot.
 */
export type ReportCardScope = ExamCode | null;

/** Papers worth printing or sending, in exam order. */
export function papersWithContent(card: ExamCardContent): ExamCode[] {
  return EXAM_CODES.filter((exam) => hasPaperContent(card, exam));
}

/** One label-and-value row, right-aligned. Long subject names truncate rather than wrap. */
function row(label: string, value: string, width = REPORT_TABLE_WIDTH): string {
  const room = Math.max(1, width - value.length - 1);
  const name = label.length > room ? `${label.slice(0, Math.max(1, room - 2))}..` : label;
  const gap = Math.max(1, width - name.length - value.length);
  return name + ' '.repeat(gap) + value;
}

/**
 * The letterhead and the student's details, mirroring the top of the printed card.
 *
 * Outside the monospace fence on purpose: a whole message in monospace renders small and
 * cramped on a phone, so only the part that needs its columns aligned is fenced.
 */
function heading(input: ReportCardInput, scope: ReportCardScope): string[] {
  const title = scope === null ? 'Report Card' : `${EXAM_LABELS[scope]} Report Card`;
  const lines = [`*${input.schoolName}*`];

  if (input.schoolAddress) lines.push(input.schoolAddress);
  lines.push(`_${title} · ${input.academicYear}_`, '');

  lines.push(`Name: *${input.fullName}*`);
  // "Parent" rather than the relation, matching the printed card's label.
  if (input.guardian) lines.push(`Parent: ${input.guardian.name}`);
  lines.push(
    `${classLabel(input.classCode)}${input.rollNo === null ? '' : ` · Roll ${input.rollNo}`}`,
    '',
  );

  return lines;
}

function papersInScope(input: ReportCardInput, scope: ReportCardScope): ExamCode[] {
  const papers = papersWithContent(input);
  return scope === null ? papers : papers.filter((exam) => exam === scope);
}

/**
 * One paper as a table: a column heading, the subjects, then the total and percentage
 * below a rule — the same order and the same three sections as the printed card.
 */
function paperBlock(input: ReportCardInput, exam: ExamCode, labelled: boolean): string[] | null {
  if (!hasPaperContent(input, exam)) return null;

  const marks = input.subjectMarks[exam];
  const total = examTotal(marks, input.classCode, exam);
  const grades = GRADED_SUBJECT_CODES.map((subject) => ({
    label: SUBJECT_LABELS[subject],
    value: input.subjectGrades[exam][subject],
  })).filter((entry): entry is { label: string; value: string } => entry.value !== null);

  // A single-paper card already names the paper in its heading; repeating it two lines
  // later reads like a mistake.
  const lines = labelled ? [`*${EXAM_LABELS[exam]}*`, FENCE] : [FENCE];

  if (total) {
    const max = MAX_SUBJECT_MARK[exam];
    lines.push(row('SUBJECT', 'MARKS'), THIN_RULE);
    for (const [subject, mark] of Object.entries(marks) as [keyof typeof marks, number | null][]) {
      if (mark === null) continue;
      lines.push(row(SUBJECT_LABELS[subject], `${mark}/${max}`));
    }
    lines.push(THICK_RULE);
    lines.push(row('TOTAL', `${total.obtained}/${total.max}`));
    lines.push(row('PERCENTAGE', `${total.percent.toFixed(2)}%`));
  } else if (input.scores[exam] !== null) {
    // No subject marks behind it — a paper recorded before subject-wise entry.
    lines.push(row('PERCENTAGE', `${input.scores[exam]!.toFixed(2)}%`));
  }

  if (grades.length > 0) {
    lines.push(THIN_RULE, 'CO-SCHOLASTIC');
    for (const grade of grades) lines.push(row(grade.label, grade.value));
  }

  lines.push(FENCE);
  return lines;
}

/**
 * The full card: every paper with something on it, subject by subject.
 *
 * Grades sit inside their paper's block, below the total rather than within it, because
 * they are not part of one — the same separation the schema draws and the printed card
 * shows as its own table.
 */
export function buildReportCardMessage(input: ReportCardInput, scope: ReportCardScope = null): string {
  const header = heading(input, scope);
  const blocks = papersInScope(input, scope)
    .map((exam) => paperBlock(input, exam, scope === null))
    .filter((block): block is string[] => block !== null);

  if (blocks.length === 0) {
    return [...header, '_Nothing recorded yet._'].join('\n');
  }

  return [...header, ...blocks.flatMap((block) => [...block, ''])].join('\n').trimEnd();
}

/**
 * The same card with the subject breakdown dropped — one line per paper.
 *
 * A fallback for when the itemised version would overflow the `wa.me` URL, which a class-8
 * card with all six papers and seven subjects does. Losing the breakdown is better than
 * losing the tail of the message, which is where the final exam sits.
 */
export function buildCompactReportCardMessage(
  input: ReportCardInput,
  scope: ReportCardScope = null,
): string {
  const lines = [...heading(input, scope), FENCE, row('EXAM', 'RESULT'), THIN_RULE];

  let any = false;
  for (const exam of papersInScope(input, scope)) {
    const total = examTotal(input.subjectMarks[exam], input.classCode, exam);
    const percent = total ? total.percent : input.scores[exam];
    if (percent === null) continue;
    any = true;
    // One space between the marks and the percentage, not two: at two, the value column
    // is 15 wide and "Half-Yearly" no longer fits beside it, truncating to "Half-Yea..".
    const marks = total ? `${total.obtained}/${total.max}` : '';
    lines.push(row(EXAM_LABELS[exam], `${marks}${marks ? ' ' : ''}${percent.toFixed(2)}%`));
  }

  if (!any) return [...heading(input, scope), '_Nothing recorded yet._'].join('\n');

  lines.push(FENCE);
  return lines.join('\n');
}
