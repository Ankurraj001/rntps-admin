import { zodResolver } from '@hookform/resolvers/zod';
import {
  CLASS_CODES,
  GENDERS,
  GUARDIAN_RELATIONS,
  classLabel,
  createStudentSchema,
  formatINR,
  toDateKey,
  type CreateStudentInput,
  type SiblingDto,
} from '@rntps/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { feeKeys, feesApi } from '@/api/fees';
import { studentKeys, studentsApi } from '@/api/students';
import { SiblingPicker } from '@/components/students/SiblingPicker';
import { PageHeader } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { ErrorBlock, LoadingBlock, Spinner } from '@/components/ui/Feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { ApiError } from '@/lib/api';

const EMPTY_GUARDIAN = {
  name: '',
  relation: 'FATHER' as const,
  phone: '',
  isPrimary: true,
  whatsappOptOut: false,
};

function blankStudent(): CreateStudentInput {
  return {
    fullName: '',
    dob: '',
    gender: 'MALE',
    classCode: '1',
    rollNo: null,
    admissionDate: toDateKey(),
    aadhaar: '',
    apaarId: '',
    guardians: [{ ...EMPTY_GUARDIAN }],
    address: { line1: '', line2: '', city: '', state: '', pincode: '' },
    transportOpted: false,
    transportFareOverrideRupees: null,
    concession: { type: 'NONE', value: 0, reason: '' },
    notes: '',
  };
}

/** Stored numbers are 91XXXXXXXXXX; the form shows the 10 digits people type. */
function toLocalPhone(stored: string): string {
  return stored.startsWith('91') ? stored.slice(2) : stored;
}

export function StudentFormPage({ mode }: { mode: 'create' | 'edit' }) {
  const { studentId } = useParams<{ studentId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [sibling, setSibling] = useState<SiblingDto | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState<string | null>(null);

  const existing = useQuery({
    queryKey: studentKeys.detail(studentId ?? ''),
    queryFn: () => studentsApi.get(studentId as string),
    enabled: mode === 'edit' && Boolean(studentId),
  });

  const form = useForm<CreateStudentInput>({
    resolver: zodResolver(createStudentSchema),
    defaultValues: blankStudent(),
    // Errors appear only after the first submit, then update live. Validating on blur
    // flagged "Full name is required" the moment focus left the autofocused field,
    // before the admin had typed anything.
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });

  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'guardians' });

  const selectedClass = form.watch('classCode');
  const usesTransport = form.watch('transportOpted') === true;

  // Fee structures are admin-only, and so is this form, so this is a safe extra query.
  // It exists purely so the fare field can say what it is overriding.
  const structures = useQuery({ queryKey: feeKeys.structures(), queryFn: () => feesApi.structures() });
  const classDefaultTransportRupees =
    structures.data?.items
      .find((structure) => structure.classCode === selectedClass)
      ?.heads.find((head) => head.appliesTo === 'TRANSPORT_OPTED')?.amountRupees ?? null;

  // Populate the form once the student being edited arrives.
  useEffect(() => {
    if (mode !== 'edit' || !existing.data) return;
    const student = existing.data;
    form.reset({
      fullName: student.fullName,
      dob: student.dob,
      gender: student.gender,
      classCode: student.classCode,
      rollNo: student.rollNo,
      admissionDate: student.admissionDate,
      aadhaar: student.aadhaar ?? '',
      apaarId: student.apaarId ?? '',
      guardians: student.guardians.map((g) => ({ ...g, phone: toLocalPhone(g.phone) })),
      address: student.address,
      transportOpted: student.transportOpted,
      transportFareOverrideRupees: student.transportFareOverrideRupees,
      concession: student.concession,
      notes: student.notes,
    });
  }, [existing.data, form, mode]);

  /** Selecting a sibling copies over the family's guardians and address. */
  async function handleSiblingSelect(selected: SiblingDto) {
    setSibling(selected);
    try {
      const defaults = await studentsApi.familyDefaults(selected.studentId);
      form.setValue(
        'guardians',
        defaults.guardians.map((g) => ({ ...g, phone: toLocalPhone(g.phone) })),
        { shouldValidate: true },
      );
      form.setValue('address', defaults.address, { shouldValidate: true });
    } catch {
      // Pre-filling is a convenience; the admin can still type the details by hand.
      setServerError('Could not load the sibling details — please fill the guardian fields manually.');
    }
  }

  const mutation = useMutation({
    mutationFn: (values: CreateStudentInput) => {
      if (mode === 'edit' && studentId) {
        const { studentId: _ignored, siblingOfStudentId: _sibling, ...rest } = values;
        return studentsApi.update(studentId, rest);
      }
      return studentsApi.create({
        ...values,
        ...(sibling ? { siblingOfStudentId: sibling.studentId } : {}),
      });
    },
    onSuccess: async (student) => {
      await queryClient.invalidateQueries({ queryKey: studentKeys.all });
      if (mode === 'edit') {
        navigate(`/students/${student.studentId}`);
        return;
      }
      setJustSaved(student.studentId);
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        // Re-attach server-side field errors to the matching inputs.
        for (const detail of error.fieldErrors) {
          form.setError(detail.field as keyof CreateStudentInput, { message: detail.message });
        }
        setServerError(error.fieldErrors.length ? null : error.message);
        return;
      }
      setServerError((error as Error).message);
    },
  });

  /** Keeps "Save & add another" fast: same class and family, empty child details. */
  function resetForNextChild() {
    const previous = form.getValues();
    setJustSaved(null);
    form.reset({
      ...blankStudent(),
      classCode: previous.classCode,
      admissionDate: previous.admissionDate,
      ...(sibling ? { guardians: previous.guardians, address: previous.address } : {}),
    });
  }

  function setPrimaryGuardian(index: number) {
    const guardians = form.getValues('guardians') ?? [];
    guardians.forEach((_, i) => form.setValue(`guardians.${i}.isPrimary`, i === index));
  }

  if (mode === 'edit' && existing.isPending) return <LoadingBlock label="Loading student…" />;
  if (mode === 'edit' && existing.error) {
    return <div className="p-6"><ErrorBlock message={(existing.error as Error).message} /></div>;
  }

  const errors = form.formState.errors;

  if (justSaved) {
    return (
      <>
        <PageHeader title="Student onboarded" />
        <div className="p-6">
          <Card className="mx-auto max-w-lg">
            <CardBody className="space-y-4 text-center">
              <p className="text-sm text-slate-600">Saved with student ID</p>
              <p className="font-mono text-2xl font-semibold text-slate-900">{justSaved}</p>
              <div className="flex flex-wrap justify-center gap-2 pt-2">
                <Button onClick={resetForNextChild}>Save &amp; add another</Button>
                <Link to={`/students/${justSaved}`}>
                  <Button variant="secondary">View student</Button>
                </Link>
                <Link to="/students">
                  <Button variant="ghost">Back to list</Button>
                </Link>
              </div>
            </CardBody>
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={mode === 'create' ? 'Onboard student' : `Edit ${existing.data?.fullName ?? ''}`}
        description={
          mode === 'create'
            ? 'The student ID is generated automatically unless you enter one.'
            : 'The student ID and family link cannot be changed after onboarding.'
        }
        action={
          <Link to={mode === 'edit' && studentId ? `/students/${studentId}` : '/students'}>
            <Button variant="ghost">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Cancel
            </Button>
          </Link>
        }
      />

      <form
        onSubmit={form.handleSubmit((values) => {
          setServerError(null);
          mutation.mutate(values);
        })}
        className="mx-auto max-w-3xl space-y-5 p-6"
      >
        {serverError && <ErrorBlock message={serverError} />}

        <Card>
          <CardHeader title="Student details" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" htmlFor="fullName" required error={errors.fullName?.message} className="sm:col-span-2">
              <Input id="fullName" autoFocus placeholder="e.g. Aarav Sharma" {...form.register('fullName')} />
            </Field>

            <Field label="Date of birth" htmlFor="dob" required error={errors.dob?.message}>
              <Input id="dob" type="date" {...form.register('dob')} />
            </Field>

            <Field label="Gender" htmlFor="gender" required error={errors.gender?.message}>
              <Select id="gender" {...form.register('gender')}>
                {GENDERS.map((value) => (
                  <option key={value} value={value}>
                    {value.charAt(0) + value.slice(1).toLowerCase()}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Class" htmlFor="classCode" required error={errors.classCode?.message}>
              <Select id="classCode" {...form.register('classCode')}>
                {CLASS_CODES.map((code) => (
                  <option key={code} value={code}>
                    {classLabel(code)}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Roll number" htmlFor="rollNo" error={errors.rollNo?.message} hint="Optional — must be unique within the class">
              <Input
                id="rollNo"
                type="number"
                min={1}
                max={999}
                {...form.register('rollNo', { setValueAs: (v) => (v === '' || v === null ? null : Number(v)) })}
              />
            </Field>

            <Field label="Admission date" htmlFor="admissionDate" required error={errors.admissionDate?.message}>
              <Input id="admissionDate" type="date" {...form.register('admissionDate')} />
            </Field>

            {mode === 'create' && (
              <Field
                label="Student ID"
                htmlFor="studentId"
                error={errors.studentId?.message}
                hint="Leave blank to generate one automatically"
              >
                <Input id="studentId" placeholder="Auto-generated" {...form.register('studentId')} />
              </Field>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Government identifiers"
            description="Both optional. Needed for UDISE+ returns and government schemes."
          />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Aadhaar number"
              htmlFor="aadhaar"
              error={errors.aadhaar?.message}
              hint="12 digits. Checked against the number's own check digit, so a typo is caught here."
            >
              <Input
                id="aadhaar"
                inputMode="numeric"
                placeholder="2345 6789 0123"
                {...form.register('aadhaar')}
              />
            </Field>

            <Field
              label="APAAR ID / PEN"
              htmlFor="apaarId"
              error={errors.apaarId?.message}
              hint="Permanent Education Number, as issued by APAAR or UDISE+"
            >
              <Input id="apaarId" placeholder="e.g. 123456789012" {...form.register('apaarId')} />
            </Field>
          </CardBody>
        </Card>

        {mode === 'create' && (
          <Card>
            <CardHeader
              title="Sibling in school"
              description="Link a brother or sister already on the roll to share one family record."
            />
            <CardBody>
              <SiblingPicker
                selected={sibling}
                onSelect={(selected) => void handleSiblingSelect(selected)}
                onClear={() => setSibling(null)}
              />
              {sibling && (
                <p className="mt-2 text-xs text-slate-500">
                  Guardian and address details were copied from {sibling.fullName}. Fee reminders will go to
                  this family as a single message.
                </p>
              )}
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Guardians"
            description="Fee reminders go to the primary guardian's WhatsApp number."
            action={
              fields.length < 4 ? (
                <Button type="button" variant="secondary" size="sm" onClick={() => append({ ...EMPTY_GUARDIAN, isPrimary: false })}>
                  <Plus className="h-4 w-4" aria-hidden />
                  Add guardian
                </Button>
              ) : undefined
            }
          />
          <CardBody className="space-y-4">
            {typeof errors.guardians?.message === 'string' && (
              <p role="alert" className="text-xs font-medium text-red-600">{errors.guardians.message}</p>
            )}

            {fields.map((field, index) => (
              <div key={field.id} className="rounded-md border border-slate-200 p-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Name" required error={errors.guardians?.[index]?.name?.message}>
                    <Input placeholder="Guardian name" {...form.register(`guardians.${index}.name`)} />
                  </Field>

                  <Field label="Relation" required error={errors.guardians?.[index]?.relation?.message}>
                    <Select {...form.register(`guardians.${index}.relation`)}>
                      {GUARDIAN_RELATIONS.map((value) => (
                        <option key={value} value={value}>
                          {value.charAt(0) + value.slice(1).toLowerCase()}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <Field
                    label="Mobile number"
                    required
                    error={errors.guardians?.[index]?.phone?.message}
                    hint="10 digits — used for WhatsApp"
                  >
                    <Input inputMode="numeric" placeholder="9876543210" {...form.register(`guardians.${index}.phone`)} />
                  </Field>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="primaryGuardian"
                      checked={form.watch(`guardians.${index}.isPrimary`) === true}
                      onChange={() => setPrimaryGuardian(index)}
                    />
                    Primary contact
                  </label>

                  <label className="flex items-center gap-2 text-slate-600">
                    <input type="checkbox" {...form.register(`guardians.${index}.whatsappOptOut`)} />
                    No WhatsApp
                  </label>

                  {fields.length > 1 && (
                    <Button type="button" variant="ghost" size="sm" className="ml-auto text-red-600" onClick={() => remove(index)}>
                      <Trash2 className="h-4 w-4" aria-hidden />
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Address & other details" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Address line 1" className="sm:col-span-2" error={errors.address?.line1?.message}>
              <Input {...form.register('address.line1')} />
            </Field>
            <Field label="City" error={errors.address?.city?.message}>
              <Input {...form.register('address.city')} />
            </Field>
            <Field label="State" error={errors.address?.state?.message}>
              <Input {...form.register('address.state')} />
            </Field>
            <Field label="PIN code" error={errors.address?.pincode?.message}>
              <Input inputMode="numeric" maxLength={6} {...form.register('address.pincode')} />
            </Field>

            <Field label="Transport" error={undefined}>
              <label className="flex h-10 items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" {...form.register('transportOpted')} />
                Uses school transport
              </label>
            </Field>

            <Field
              label="Transport fare (₹)"
              htmlFor="transportFare"
              error={errors.transportFareOverrideRupees?.message}
              hint={
                classDefaultTransportRupees === null
                  ? 'This class has no transport fee, so set the amount here or nothing will be billed'
                  : `Blank uses the class default of ${formatINR(classDefaultTransportRupees)}`
              }
            >
              <Input
                id="transportFare"
                type="number"
                min={0}
                step="1"
                placeholder={
                  classDefaultTransportRupees === null
                    ? 'Class default'
                    : String(classDefaultTransportRupees)
                }
                disabled={!usesTransport}
                {...form.register('transportFareOverrideRupees', {
                  // Blank means "use the class default", which is null rather than 0 —
                  // zero is a real fare for a child who travels free.
                  setValueAs: (value) =>
                    value === '' || value === null ? null : Math.trunc(Number(value)),
                })}
              />
            </Field>

            <Field label="Notes" className="sm:col-span-2" error={errors.notes?.message}>
              <Textarea rows={3} {...form.register('notes')} />
            </Field>
          </CardBody>
        </Card>

        <div className="flex items-center justify-end gap-3">
          <Link to={mode === 'edit' && studentId ? `/students/${studentId}` : '/students'}>
            <Button type="button" variant="secondary">Cancel</Button>
          </Link>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending && <Spinner />}
            {mode === 'create' ? 'Onboard student' : 'Save changes'}
          </Button>
        </div>
      </form>
    </>
  );
}
