import { classLabel, type SiblingDto } from '@rntps/shared';
import { useQuery } from '@tanstack/react-query';
import { Check, Search, X } from 'lucide-react';
import { useState } from 'react';
import { studentsApi } from '@/api/students';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Feedback';
import { useDebounced } from '@/hooks/useDebounced';

interface SiblingPickerProps {
  selected: SiblingDto | null;
  onSelect: (sibling: SiblingDto) => void;
  onClear: () => void;
}

/**
 * Links a new student to a sibling already on the roll. Selecting one makes the new
 * record join that family (shared familyId) and pre-fills the guardian and address
 * details, which is most of the typing saved during manual onboarding.
 */
export function SiblingPicker({ selected, onSelect, onClear }: SiblingPickerProps) {
  const [term, setTerm] = useState('');
  const debounced = useDebounced(term);

  const { data, isFetching } = useQuery({
    queryKey: ['sibling-search', debounced],
    queryFn: () => studentsApi.searchSibling(debounced),
    enabled: debounced.trim().length >= 2 && !selected,
  });

  if (selected) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5">
        <div className="flex items-center gap-2 text-sm">
          <Check className="h-4 w-4 text-emerald-600" aria-hidden />
          <span className="font-medium text-slate-900">{selected.fullName}</span>
          <span className="text-slate-500">
            {classLabel(selected.classCode)} · {selected.studentId}
          </span>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClear}>
          <X className="h-4 w-4" aria-hidden />
          Unlink
        </Button>
      </div>
    );
  }

  const results = data?.items ?? [];
  const searched = debounced.trim().length >= 2;

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <Input
          aria-label="Search for a sibling already in school"
          placeholder="Search sibling by name or student ID"
          className="pl-9"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
        />
        {isFetching && <Spinner className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />}
      </div>

      {searched && !isFetching && results.length === 0 && (
        <p className="text-xs text-slate-500">
          No active student matches "{debounced}". Leave this blank if the child has no sibling here.
        </p>
      )}

      {results.length > 0 && (
        <ul className="max-h-52 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
          {results.map((sibling) => (
            <li key={sibling.studentId}>
              <button
                type="button"
                onClick={() => onSelect(sibling)}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50"
              >
                <span className="font-medium text-slate-900">{sibling.fullName}</span>
                <span className="text-xs text-slate-500">
                  {classLabel(sibling.classCode)} · {sibling.studentId}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
