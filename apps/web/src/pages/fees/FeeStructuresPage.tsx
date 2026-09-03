import { CLASS_CODES, classLabel, formatINR, upsertFeeStructureSchema, type FeeHead } from '@rntps/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { feeKeys, feesApi } from '@/api/fees';
import { settingsApi, settingsKeys } from '@/api/settings';
import { PageHeader } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { ErrorBlock, LoadingBlock, Spinner } from '@/components/ui/Feedback';
import { Field, Input } from '@/components/ui/Field';
import { ApiError, type ApiFieldError } from '@/lib/api';

type HeadSubfield = 'code' | 'name' | 'amountRupees' | 'appliesTo';

interface HeadFieldErrors {
  rows: Record<number, Partial<Record<HeadSubfield, string>>>;
  summary?: string;
}

/**
 * Turns a flat `{field, message}` list — from either the server's `ApiError.fieldErrors`
 * or a client-side `upsertFeeStructureSchema.safeParse` — into per-row errors the form can
 * point at. `field` is `"heads"` for a whole-array issue (the min-length or duplicate-code
 * message) or `"heads.<index>.<subfield>"` for one row's one field, matching how
 * `apps/api/src/middleware/validate.ts` joins a Zod issue's path.
 */
function parseHeadFieldErrors(errors: ApiFieldError[]): HeadFieldErrors {
  const result: HeadFieldErrors = { rows: {} };
  for (const { field, message } of errors) {
    const parts = field.split('.');
    if (parts[0] !== 'heads') continue;
    if (parts.length === 1) {
      result.summary = message;
      continue;
    }
    const index = Number(parts[1]);
    const subfield = parts[2] as HeadSubfield | undefined;
    if (Number.isNaN(index) || !subfield) continue;
    result.rows[index] = { ...result.rows[index], [subfield]: message };
  }
  return result;
}

/**
 * The server's duplicate-code message doesn't name which rows collide, so every row
 * sharing an offending code is flagged locally — both of them, not just the second.
 */
function duplicateCodeErrors(heads: FeeHead[]): Record<number, string> {
  const indicesByCode = new Map<string, number[]>();
  heads.forEach((head, index) => {
    if (!head.code) return;
    const list = indicesByCode.get(head.code) ?? [];
    list.push(index);
    indicesByCode.set(head.code, list);
  });
  const errors: Record<number, string> = {};
  for (const indices of indicesByCode.values()) {
    if (indices.length > 1) indices.forEach((i) => (errors[i] = 'Duplicate code'));
  }
  return errors;
}

export function FeeStructuresPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: settingsKeys.all, queryFn: settingsApi.get });
  const year = settings.data?.activeAcademicYear;

  const structures = useQuery({
    queryKey: feeKeys.structures(year),
    queryFn: () => feesApi.structures(year),
    enabled: Boolean(year),
  });

  const [classCode, setClassCode] = useState<string>('1');
  const [heads, setHeads] = useState<FeeHead[]>([]);
  const [saved, setSaved] = useState(false);
  // Errors stay hidden until Save is actually clicked once, so a freshly-added blank row
  // (from "Add head") doesn't light up red before the admin has had a chance to fill it in.
  const [attemptedSave, setAttemptedSave] = useState(false);

  const existing = structures.data?.items.find((s) => s.classCode === classCode);

  // Load the selected class's heads, or start from a sensible default.
  useEffect(() => {
    setSaved(false);
    setAttemptedSave(false);
    setHeads(
      existing
        ? existing.heads.map((h) => ({ ...h }))
        : [{ code: 'TUITION', name: 'Tuition Fee', amountRupees: 500, appliesTo: 'ALL' }],
    );
  }, [classCode, existing]);

  const save = useMutation({
    mutationFn: () => feesApi.saveStructure(classCode, year as string, heads),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: feeKeys.all });
    },
  });

  const clone = useMutation({
    mutationFn: (toYear: string) => feesApi.cloneStructures(year as string, toYear),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: feeKeys.all }),
  });

  if (settings.isPending || structures.isPending || !structures.data || !year) return <LoadingBlock />;

  const monthlyTotal = heads.reduce((sum, head) => sum + head.amountRupees, 0);

  // Client-side check mirrors the server's own schema exactly, so a blank or duplicate row
  // is caught instantly, before a round trip — and the server's response still backstops
  // anything the client check doesn't (e.g. a stale client bundle).
  const clientResult = attemptedSave ? upsertFeeStructureSchema.safeParse({ heads }) : null;
  const clientFieldErrors =
    clientResult && !clientResult.success
      ? parseHeadFieldErrors(clientResult.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })))
      : { rows: {} };
  const serverFieldErrors =
    attemptedSave && save.error instanceof ApiError && save.error.fieldErrors.length > 0
      ? parseHeadFieldErrors(save.error.fieldErrors)
      : { rows: {} };
  const duplicates = attemptedSave ? duplicateCodeErrors(heads) : {};

  const headErrors: HeadFieldErrors = { rows: {}, summary: clientFieldErrors.summary ?? serverFieldErrors.summary };
  heads.forEach((_head, index) => {
    const merged = {
      ...serverFieldErrors.rows[index],
      ...clientFieldErrors.rows[index],
      ...(duplicates[index] ? { code: duplicates[index] } : {}),
    };
    if (Object.keys(merged).length > 0) headErrors.rows[index] = merged;
  });

  function handleSave() {
    setAttemptedSave(true);
    if (!upsertFeeStructureSchema.safeParse({ heads }).success) return;
    save.mutate();
  }

  function updateHead(index: number, patch: Partial<FeeHead>) {
    setHeads((current) => current.map((head, i) => (i === index ? { ...head, ...patch } : head)));
    setSaved(false);
  }

  return (
    <>
      <PageHeader
        title="Fee structure"
        description={`Monthly fee heads per class for ${year}. Invoices are generated from these.`}
        action={
          <Button
            variant="secondary"
            onClick={() => {
              const next = window.prompt('Copy every class’s structure to which academic year?', '2027-28');
              if (next) clone.mutate(next);
            }}
            disabled={clone.isPending}
          >
            <Copy className="h-4 w-4" aria-hidden />
            Copy to next year
          </Button>
        }
      />

      <div className="space-y-4 p-6">
        {save.error && !(save.error instanceof ApiError && save.error.fieldErrors.length > 0) && (
          <ErrorBlock message={(save.error as Error).message} />
        )}
        {clone.error && <ErrorBlock message={(clone.error as Error).message} />}
        {clone.data && (
          <div className="rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            Copied {clone.data.copied} structure{clone.data.copied === 1 ? '' : 's'}
            {clone.data.skipped > 0 && `, skipped ${clone.data.skipped} that already existed`}.
          </div>
        )}

        <Card>
          <CardHeader title="Classes" description="Classes without a structure cannot be invoiced." />
          <CardBody>
            <div className="flex flex-wrap gap-2">
              {CLASS_CODES.map((code) => {
                const structure = structures.data.items.find((s) => s.classCode === code);
                const active = code === classCode;
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => setClassCode(code)}
                    className={[
                      'rounded-md border px-3 py-2 text-left text-sm transition-colors',
                      active ? 'border-brand-600 bg-brand-50' : 'border-slate-300 hover:bg-slate-50',
                    ].join(' ')}
                  >
                    <span className="block font-medium text-slate-900">{classLabel(code)}</span>
                    <span className={structure ? 'text-xs text-slate-600' : 'text-xs text-amber-700'}>
                      {structure ? formatINR(structure.monthlyTotalRupees) : 'Not set'}
                    </span>
                  </button>
                );
              })}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title={`${classLabel(classCode)} — fee heads`}
            description="Applies to every student in this class. Transport fares are set on each student's own profile, not here."
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setHeads((current) => [...current, { code: '', name: '', amountRupees: 0, appliesTo: 'ALL' }])
                }
              >
                <Plus className="h-4 w-4" aria-hidden />
                Add head
              </Button>
            }
          />
          <CardBody className="space-y-3">
            {headErrors.summary && (
              <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {headErrors.summary}
              </div>
            )}

            {heads.map((head, index) => (
              <div key={index} className="grid gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-12">
                <Field label="Code" className="sm:col-span-3" error={headErrors.rows[index]?.code}>
                  <Input
                    placeholder="TUITION"
                    value={head.code}
                    onChange={(e) => updateHead(index, { code: e.target.value.toUpperCase() })}
                  />
                </Field>
                <Field label="Name" className="sm:col-span-6" error={headErrors.rows[index]?.name}>
                  <Input
                    placeholder="Tuition Fee"
                    value={head.name}
                    onChange={(e) => updateHead(index, { name: e.target.value })}
                  />
                </Field>
                <Field label="Amount (₹)" className="sm:col-span-2" error={headErrors.rows[index]?.amountRupees}>
                  <Input
                    type="number"
                    min={0}
                    step="1"
                    value={head.amountRupees}
                    onChange={(e) =>
                      updateHead(index, { amountRupees: Math.trunc(Number(e.target.value || 0)) })
                    }
                  />
                </Field>
                <div className="flex items-end sm:col-span-1">
                  {heads.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-red-600"
                      aria-label="Remove head"
                      onClick={() => setHeads((current) => current.filter((_, i) => i !== index))}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  )}
                </div>
              </div>
            ))}

            <div className="flex items-center justify-between border-t border-slate-200 pt-4">
              <p className="text-sm text-slate-600">
                Monthly fee: <strong>{formatINR(monthlyTotal)}</strong>
              </p>
              <div className="flex items-center gap-3">
                {saved && <span className="text-sm text-emerald-700">Saved</span>}
                <Button onClick={handleSave} disabled={save.isPending}>
                  {save.isPending && <Spinner />}
                  Save {classLabel(classCode)}
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
