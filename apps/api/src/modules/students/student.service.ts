import { randomUUID } from 'node:crypto';
import {
  CLASS_CODES,
  nextAcademicYear,
  nextClassCode,
  type AddChargePayload,
  type ClassCode,
  type ListStudentsQuery,
  type Paginated,
  type RolloverStatusDto,
  type SiblingDto,
  type StudentChargeDto,
  type StudentDto,
  type CreateStudentPayload,
  type UpdateStudentPayload,
} from '@rntps/shared';
import { AppError } from '../../lib/AppError.js';
import { duplicateKeyIncludes, isDuplicateKeyError } from '../../lib/mongoErrors.js';
import { generateFamilyId, generateStudentId, getSettings } from '../../lib/ids.js';
import { FeeStructure } from '../../models/FeeStructure.js';
import { Invoice } from '../../models/Invoice.js';
import { Student, type StudentDoc } from '../../models/Student.js';

export function toDto(doc: StudentDoc): StudentDto {
  return {
    studentId: doc._id,
    fullName: doc.fullName,
    dob: doc.dob,
    gender: doc.gender,
    classCode: doc.classCode,
    rollNo: doc.rollNo,
    admissionDate: doc.admissionDate,
    aadhaar: doc.aadhaar,
    apaarId: doc.apaarId,
    status: doc.status,
    academicYear: doc.academicYear,
    familyId: doc.familyId,
    guardians: doc.guardians.map((g) => ({ ...g })),
    address: { ...doc.address },
    concession: { ...doc.concession },
    transportOpted: doc.transportOpted,
    transportFareOverrideRupees: doc.transportFareOverrideRupees ?? null,
    notes: doc.notes,
    createdAt: doc.createdAt?.toISOString() ?? '',
    updatedAt: doc.updatedAt?.toISOString() ?? '',
  };
}

/** Escapes user input before it becomes part of a regex, so "a.*b" is treated literally. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function listStudents(query: ListStudentsQuery): Promise<Paginated<StudentDto>> {
  const filter: Record<string, unknown> = {};
  if (query.classCode) filter.classCode = query.classCode;
  if (query.status) filter.status = query.status;
  if (query.familyId) filter.familyId = query.familyId;
  if (query.q) {
    const pattern = new RegExp(escapeRegex(query.q), 'i');
    filter.$or = [
      { fullName: pattern },
      { _id: pattern },
      { 'guardians.phone': pattern },
      { aadhaar: pattern },
      { apaarId: pattern },
    ];
  }

  const sortField = query.sort === 'createdAt' ? 'createdAt' : query.sort;
  const sort: Record<string, 1 | -1> = { [sortField]: query.order === 'desc' ? -1 : 1 };
  if (sortField !== 'fullName') sort.fullName = 1;

  const [items, total] = await Promise.all([
    Student.find(filter)
      .sort(sort)
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean<StudentDoc[]>(),
    Student.countDocuments(filter),
  ]);

  return {
    items: items.map(toDto),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

export async function getStudent(studentId: string): Promise<StudentDto> {
  const doc = await Student.findById(studentId.toUpperCase()).lean<StudentDoc>();
  if (!doc) throw AppError.notFound(`No student found with ID ${studentId}`);
  return toDto(doc);
}

/** Siblings are simply the other students sharing this student's familyId. */
export async function getSiblings(studentId: string): Promise<SiblingDto[]> {
  const student = await Student.findById(studentId.toUpperCase())
    .select('familyId')
    .lean<Pick<StudentDoc, 'familyId'>>();
  if (!student) throw AppError.notFound(`No student found with ID ${studentId}`);

  const siblings = await Student.find({ familyId: student.familyId, _id: { $ne: studentId.toUpperCase() } })
    .select('fullName classCode status')
    .sort({ fullName: 1 })
    .lean<Pick<StudentDoc, '_id' | 'fullName' | 'classCode' | 'status'>[]>();

  return siblings.map((s) => ({
    studentId: s._id,
    fullName: s.fullName,
    classCode: s.classCode,
    status: s.status,
  }));
}

/** Powers the "has a sibling in school" picker on the onboarding form. */
export async function searchSiblingCandidates(term: string, limit = 10): Promise<SiblingDto[]> {
  if (term.trim().length < 2) return [];
  const pattern = new RegExp(escapeRegex(term.trim()), 'i');
  const matches = await Student.find({
    status: 'ACTIVE',
    $or: [{ fullName: pattern }, { _id: pattern }],
  })
    .select('fullName classCode status')
    .sort({ fullName: 1 })
    .limit(limit)
    .lean<Pick<StudentDoc, '_id' | 'fullName' | 'classCode' | 'status'>[]>();

  return matches.map((s) => ({
    studentId: s._id,
    fullName: s.fullName,
    classCode: s.classCode,
    status: s.status,
  }));
}

/**
 * Returns the guardian and address details of an existing student so the onboarding form
 * can pre-fill them when a sibling is selected — the main reason sibling linking exists.
 */
export async function getFamilyDefaults(studentId: string): Promise<
  Pick<StudentDto, 'familyId' | 'guardians' | 'address'> & { siblings: SiblingDto[] }
> {
  const doc = await Student.findById(studentId.toUpperCase())
    .select('familyId guardians address')
    .lean<StudentDoc>();
  if (!doc) throw AppError.notFound(`No student found with ID ${studentId}`);

  return {
    familyId: doc.familyId,
    guardians: doc.guardians.map((g) => ({ ...g })),
    address: { ...doc.address },
    siblings: await getSiblings(studentId),
  };
}

export async function createStudent(
  payload: CreateStudentPayload,
  actor: string | null = null,
): Promise<StudentDto> {
  const settings = await getSettings();

  // A sibling link means joining an existing family rather than starting a new one.
  let familyId: string;
  if (payload.siblingOfStudentId) {
    const sibling = await Student.findById(payload.siblingOfStudentId.toUpperCase())
      .select('familyId')
      .lean<Pick<StudentDoc, 'familyId'>>();
    if (!sibling) {
      throw AppError.badRequest(`No student found with ID ${payload.siblingOfStudentId} to link as a sibling`);
    }
    familyId = sibling.familyId;
  } else {
    familyId = await generateFamilyId();
  }

  const base = {
    fullName: payload.fullName,
    dob: payload.dob,
    gender: payload.gender,
    classCode: payload.classCode,
    rollNo: payload.rollNo,
    admissionDate: payload.admissionDate,
    aadhaar: payload.aadhaar ?? null,
    apaarId: payload.apaarId ?? null,
    status: 'ACTIVE' as const,
    academicYear: settings.activeAcademicYear,
    familyId,
    guardians: payload.guardians,
    address: payload.address,
    transportOpted: payload.transportOpted,
    transportFareOverrideRupees: payload.transportFareOverrideRupees,
    concession: payload.concession,
    notes: payload.notes,
    createdBy: actor,
  };

  // An admin-supplied ID is used as-is; a generated one retries if the counter has
  // drifted behind an ID that was entered manually earlier.
  if (payload.studentId) {
    const existing = await Student.exists({ _id: payload.studentId.toUpperCase() });
    if (existing) throw AppError.conflict(`Student ID ${payload.studentId} is already in use`);
    const created = await Student.create({ _id: payload.studentId.toUpperCase(), ...base });
    return toDto(created.toObject());
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const studentId = await generateStudentId();
    try {
      const created = await Student.create({ _id: studentId, ...base });
      return toDto(created.toObject());
    } catch (error) {
      const isDuplicateId = isDuplicateKeyError(error) && duplicateKeyIncludes(error, '_id');
      if (!isDuplicateId) throw error;
    }
  }
  throw new AppError(500, 'Could not allocate a unique student ID. Check the counter in Settings.', 'ID_EXHAUSTED');
}

export async function updateStudent(
  studentId: string,
  payload: UpdateStudentPayload,
): Promise<StudentDto> {
  const id = studentId.toUpperCase();

  // The schema can only compare dob and admissionDate when the caller sends both. A
  // partial update changing just one has to be checked against what is already stored.
  if (payload.dob !== undefined || payload.admissionDate !== undefined) {
    const current = await Student.findById(id)
      .select('dob admissionDate')
      .lean<Pick<StudentDoc, 'dob' | 'admissionDate'>>();
    if (!current) throw AppError.notFound(`No student found with ID ${studentId}`);

    const dob = payload.dob ?? current.dob;
    const admissionDate = payload.admissionDate ?? current.admissionDate;
    if (dob >= admissionDate) {
      throw AppError.badRequest('Date of birth must be before the admission date', [
        { field: 'dob', message: 'Date of birth must be before the admission date' },
      ]);
    }
  }

  const updated = await Student.findByIdAndUpdate(
    id,
    { $set: payload },
    { new: true, runValidators: true },
  ).lean<StudentDoc>();
  if (!updated) throw AppError.notFound(`No student found with ID ${studentId}`);
  return toDto(updated);
}

/** Status changes are how students leave the roll — records are never deleted. */
export async function setStudentStatus(
  studentId: string,
  status: StudentDoc['status'],
  reason: string,
): Promise<StudentDto> {
  const student = await Student.findById(studentId.toUpperCase());
  if (!student) throw AppError.notFound(`No student found with ID ${studentId}`);

  student.status = status;
  if (reason) {
    const stamp = new Date().toISOString().slice(0, 10);
    student.notes = `${student.notes}\n[${stamp}] ${status}: ${reason}`.trim().slice(0, 1000);
  }
  // Freeing the roll number keeps the class roll-number index usable for the next intake.
  if (status !== 'ACTIVE') student.rollNo = null;

  await student.save();
  return toDto(student.toObject());
}

export interface PromotionResult {
  dryRun: boolean;
  promoted: { studentId: string; fullName: string; from: ClassCode; to: ClassCode }[];
  graduated: { studentId: string; fullName: string }[];
  skipped: { studentId: string; reason: string }[];
}

/** Statuses a rollover acts on. Anyone else has already left and is left as history. */
const ROLLOVER_STATUSES = ['ACTIVE', 'TC_ISSUED'] as const;

/**
 * Year rollover: every student on the roll moves up one class, and class 8 becomes alumni.
 * Defaults to a dry run because it touches the whole school in one call.
 *
 * Re-running is a no-op, and that property is load-bearing rather than incidental: the
 * filter selects `academicYear: from` and the update writes `academicYear: to`, so a second
 * pass matches nothing. It is also the only recovery available — the writes are unordered
 * and there is no transaction — which is why the year pair is validated so strictly below.
 */
export async function promoteStudents(input: {
  fromAcademicYear: string;
  toAcademicYear: string;
  classCodes?: ClassCode[];
  dryRun: boolean;
}): Promise<PromotionResult> {
  /**
   * Without this, `from === to` makes the filter match the very rows the update produces,
   * so every call moves the whole school up another class — and the classes that fall off
   * the top become alumni, which nothing can undo.
   */
  if (input.toAcademicYear !== nextAcademicYear(input.fromAcademicYear)) {
    throw AppError.badRequest(
      `A rollover moves one session to the next: ${input.fromAcademicYear} should be followed by ${nextAcademicYear(input.fromAcademicYear)}`,
    );
  }

  /**
   * Ties promotion to the settings flip. Promoting into a year the school is not yet in
   * would leave new admissions stamped with the old session; leaving the year flipped
   * *without* promoting makes the monthly run price last year's classes against this
   * year's structures, billing the whole school one class behind in silence.
   */
  const settings = await getSettings();
  if (input.toAcademicYear !== settings.activeAcademicYear) {
    throw AppError.badRequest(
      `Set the active academic year to ${input.toAcademicYear} before promoting — it is still ${settings.activeAcademicYear}`,
    );
  }

  const filter: Record<string, unknown> = {
    status: { $in: ROLLOVER_STATUSES },
    academicYear: input.fromAcademicYear,
  };
  if (input.classCodes?.length) filter.classCode = { $in: input.classCodes };

  const students = await Student.find(filter).select('fullName classCode status').lean<StudentDoc[]>();

  const result: PromotionResult = { dryRun: input.dryRun, promoted: [], graduated: [], skipped: [] };
  const writes: Parameters<typeof Student.bulkWrite>[0] = [];

  // Leavers keep the class they left from — there is no next class for them, and rewriting
  // it would misreport which class they were last in.
  const graduate = (student: StudentDoc) => {
    result.graduated.push({ studentId: student._id, fullName: student.fullName });
    writes.push({
      updateOne: {
        filter: { _id: student._id },
        update: { $set: { status: 'ALUMNI', rollNo: null, academicYear: input.toAcademicYear } },
      },
    });
  };

  for (const student of students) {
    // A transfer certificate has already been issued, so there is no class to move them
    // into — they leave the roll as alumni with the class they left from.
    if (student.status === 'TC_ISSUED') {
      graduate(student);
      continue;
    }

    // `nextClassCode` returns null both for the terminal class and for a code it does not
    // recognise. Treating those the same turned a corrupt record into an alumnus, which is
    // not recoverable, so the unknown case is reported instead.
    if (!CLASS_CODES.includes(student.classCode)) {
      result.skipped.push({
        studentId: student._id,
        reason: `Unrecognised class "${student.classCode}" — fix the record, then re-run`,
      });
      continue;
    }

    const target = nextClassCode(student.classCode);
    if (target === null) {
      graduate(student);
      continue;
    }

    result.promoted.push({
      studentId: student._id,
      fullName: student.fullName,
      from: student.classCode,
      to: target,
    });
    writes.push({
      updateOne: {
        filter: { _id: student._id },
        // Clearing the roll number is what lets these writes run unordered. The unique
        // index on {classCode, academicYear, rollNo} only covers numeric roll numbers, so
        // nulling it drops the document out of the index before it could collide with a
        // number already taken in the class it is moving into.
        update: { $set: { classCode: target, academicYear: input.toAcademicYear, rollNo: null } },
      },
    });
  }

  if (!input.dryRun && writes.length > 0) {
    const written = await Student.bulkWrite(writes, { ordered: false });
    /**
     * The lists above were computed before the write, so a partial failure would otherwise
     * report everyone as moved. Reporting the shortfall makes it visible; the fix is always
     * to run it again, which the year filter makes safe.
     */
    const expected = result.promoted.length + result.graduated.length;
    if (written.modifiedCount < expected) {
      result.skipped.push({
        studentId: '—',
        reason: `${expected - written.modifiedCount} of ${expected} records did not update — re-run to finish`,
      });
    }
  }
  return result;
}

/**
 * Which parts of a year rollover have been done, derived from their effects.
 *
 * Cloning the structures, setting the session year and promoting the students are three
 * independent endpoints sharing no state, so there is no flag to read — only consequences.
 */
export async function getRolloverStatus(): Promise<RolloverStatusDto> {
  const settings = await getSettings();
  const activeAcademicYear = settings.activeAcademicYear;

  const grouped = await Student.aggregate<{ _id: string; count: number }>([
    { $match: { status: { $in: ROLLOVER_STATUSES } } },
    { $group: { _id: '$academicYear', count: { $sum: 1 } } },
  ]);
  const cohorts = grouped
    .map((row) => ({ academicYear: row._id, count: row.count }))
    .sort((a, b) => a.academicYear.localeCompare(b.academicYear));

  // A cohort behind the active year means the year was already flipped and the promotion
  // is the part still outstanding. The newest of them is the session being closed —
  // anything older was missed in an earlier April and is reported as its own cohort.
  const stale = cohorts.filter((cohort) => cohort.academicYear < activeAcademicYear);
  const newestStale = stale[stale.length - 1];

  const fromAcademicYear = newestStale ? newestStale.academicYear : activeAcademicYear;
  const toAcademicYear = newestStale ? activeAcademicYear : nextAcademicYear(activeAcademicYear);

  const structuresForTarget = await FeeStructure.countDocuments({ academicYear: toAcademicYear });

  return {
    activeAcademicYear,
    fromAcademicYear,
    toAcademicYear,
    notStarted: !newestStale,
    cohorts,
    steps: {
      feeStructuresCloned: structuresForTarget > 0,
      academicYearSet: activeAcademicYear === toAcademicYear,
      studentsPromoted: !cohorts.some((cohort) => cohort.academicYear === fromAcademicYear),
    },
  };
}

/** Small dashboard aggregate: how many active students sit in each class. */
export async function countByClass(): Promise<{ classCode: string; count: number }[]> {
  const rows = await Student.aggregate<{ _id: string; count: number }>([
    { $match: { status: 'ACTIVE' } },
    { $group: { _id: '$classCode', count: { $sum: 1 } } },
  ]);
  return rows.map((row) => ({ classCode: row._id, count: row.count }));
}

/**
 * The WhatsApp fee reminders are worthless without reachable numbers, so gaps are
 * surfaced from day one rather than on the first send.
 */
export async function studentsWithoutWhatsapp(): Promise<SiblingDto[]> {
  const docs = await Student.find({
    status: 'ACTIVE',
    $or: [{ guardians: { $size: 0 } }, { guardians: { $not: { $elemMatch: { isPrimary: true, whatsappOptOut: false } } } }],
  })
    .select('fullName classCode status')
    .lean<StudentDoc[]>();

  return docs.map((d) => ({ studentId: d._id, fullName: d.fullName, classCode: d.classCode, status: d.status }));
}

// ---------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------

/**
 * Which of a student's charges have already been billed.
 *
 * Read from the invoices themselves rather than a flag on the charge. An invoice carrying
 * a charge's id *is* the record that it was billed, so the two cannot drift apart — and if
 * the run dies halfway, re-running it sees the charge as billed and will not bill it
 * again. A voided invoice bills nothing, so its lines do not count.
 */
export async function billedChargeIdsFor(studentIds: string[]): Promise<Map<string, string>> {
  const invoices = await Invoice.find({
    studentId: { $in: studentIds },
    status: { $ne: 'VOID' },
    'lineItems.chargeId': { $exists: true },
  })
    .select('_id period lineItems.chargeId')
    .lean<{ _id: string; period: string; lineItems: { chargeId?: string }[] }[]>();

  const billed = new Map<string, string>();
  for (const invoice of invoices) {
    for (const line of invoice.lineItems) {
      if (line.chargeId) billed.set(line.chargeId, invoice._id);
    }
  }
  return billed;
}

export async function listCharges(studentId: string): Promise<StudentChargeDto[]> {
  const id = studentId.toUpperCase();
  const student = await Student.findById(id).select('charges').lean<Pick<StudentDoc, 'charges'>>();
  if (!student) throw AppError.notFound(`No student found with ID ${id}`);

  const billed = await billedChargeIdsFor([id]);
  return (student.charges ?? [])
    .map((charge) => {
      const invoiceId = billed.get(charge.id) ?? null;
      return {
        id: charge.id,
        name: charge.name,
        amountRupees: charge.amountRupees,
        addedAt: charge.addedAt?.toISOString() ?? '',
        billedOnInvoiceId: invoiceId,
        // The period is the tail of the invoice key, e.g. "RNTPS-26-001:2026-09".
        billedPeriod: invoiceId ? (invoiceId.split(':')[1] ?? null) : null,
      };
    })
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
}

export async function addCharge(
  studentId: string,
  payload: AddChargePayload,
  actor: string | null,
): Promise<StudentChargeDto[]> {
  const id = studentId.toUpperCase();
  const charge = {
    id: randomUUID(),
    name: payload.name,
    amountRupees: payload.amountRupees,
    addedAt: new Date(),
    addedBy: actor,
  };

  const result = await Student.updateOne({ _id: id }, { $push: { charges: charge } });
  if (result.matchedCount === 0) throw AppError.notFound(`No student found with ID ${id}`);
  return listCharges(id);
}

/**
 * Removes a charge that has not been billed yet.
 *
 * A billed charge cannot be removed: it is a line on an invoice the parent may already
 * have paid against, and deleting it here would leave that invoice unexplained. Void or
 * adjust the invoice instead.
 */
export async function removeCharge(studentId: string, chargeId: string): Promise<StudentChargeDto[]> {
  const id = studentId.toUpperCase();
  const student = await Student.findById(id).select('charges').lean<Pick<StudentDoc, 'charges'>>();
  if (!student) throw AppError.notFound(`No student found with ID ${id}`);
  if (!(student.charges ?? []).some((charge) => charge.id === chargeId)) {
    throw AppError.notFound('No such charge on this student');
  }

  const billed = await billedChargeIdsFor([id]);
  const invoiceId = billed.get(chargeId);
  if (invoiceId) {
    throw AppError.badRequest(
      `This charge is already billed on invoice ${invoiceId}. Void or adjust that invoice instead.`,
    );
  }

  await Student.updateOne({ _id: id }, { $pull: { charges: { id: chargeId } } });
  return listCharges(id);
}
