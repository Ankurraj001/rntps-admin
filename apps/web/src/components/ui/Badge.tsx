import { cn } from '@/lib/utils';

const TONES = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  slate: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  red: 'bg-red-50 text-red-700 ring-red-600/20',
  blue: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  white: 'bg-white text-slate-600 ring-slate-300',
} as const;

export type BadgeTone = keyof typeof TONES;

export function Badge({
  tone = 'slate',
  children,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, BadgeTone> = {
  ACTIVE: 'green',
  INACTIVE: 'slate',
  TC_ISSUED: 'amber',
  ALUMNI: 'blue',
};

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  TC_ISSUED: 'TC issued',
  ALUMNI: 'Alumni',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONES[status] ?? 'slate'}>{STATUS_LABELS[status] ?? status}</Badge>;
}

/**
 * The same status as plain text, for a list where nearly every row reads the same.
 *
 * The students list defaults to the ACTIVE filter, so a coloured badge painted a whole
 * column green and drew the eye to the one thing on the row that was never in question. A
 * badge earns its emphasis where a value is exceptional; here it was noise. Shares
 * `STATUS_LABELS` with `StatusBadge` so the wording cannot drift between the two.
 */
export function StatusText({ status }: { status: string }) {
  return <span className="text-slate-600">{STATUS_LABELS[status] ?? status}</span>;
}
