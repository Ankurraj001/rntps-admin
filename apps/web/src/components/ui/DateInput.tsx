import { isValidDateKey } from '@rntps/shared';
import { Calendar } from 'lucide-react';
import { type MouseEvent, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Date entry that always reads dd-mm-yyyy.
 *
 * A native `<input type="date">` renders in the *browser's* locale, not the page's: the
 * same form shows mm/dd/yyyy on a machine set to en-US and dd/mm/yyyy on one set to en-IN,
 * and no HTML attribute can pin it. A school that writes every date day-first cannot have
 * a form that sometimes reads 09-10 as the 9th of October and sometimes as the 10th of
 * September, so the visible control is a text box this component formats itself.
 *
 * The native input is still here, hidden beside it, purely so the calendar button can open
 * the platform picker — rebuilding a calendar popup would lose the keyboard handling,
 * touch behaviour and locale week-start the browser already gets right.
 *
 * The value crossing this component's boundary is always a `dateKey` ("YYYY-MM-DD"), the
 * same shape the rest of the system uses. Only the display is reordered, and an incomplete
 * or impossible entry (31-02-2026) reports as `''` rather than a half-parsed date.
 */

const PLACEHOLDER = 'dd-mm-yyyy';

/** "2026-09-16" -> "16-09-2026". Empty for anything that is not a full dateKey. */
function toDisplayDate(dateKey: string): string {
  const [year, month, day] = dateKey.split('-');
  return year?.length === 4 && month && day ? `${day}-${month}-${year}` : '';
}

/** "16-09-2026" -> "2026-09-16". Empty while the entry is incomplete or impossible. */
function fromDisplayDate(display: string): string {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(display);
  if (!match) return '';
  const dateKey = `${match[3]}-${match[2]}-${match[1]}`;
  return isValidDateKey(dateKey) ? dateKey : '';
}

/**
 * Reflows whatever was typed into dd-mm-yyyy, separators and all.
 *
 * Working from the digits rather than from the keystroke is what keeps backspace,
 * paste and select-all-retype behaving: "16-09-202" and "1609202" both come back as
 * "16-09-202", so deleting across a hyphen does not strand the caret on one.
 */
function maskDate(raw: string): string {
  // A pasted dateKey is the one case where the digits are already in the other order —
  // it is what the rest of the app copies out, so reordering it beats rejecting it.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return toDisplayDate(raw);
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean).join('-');
}

interface DateInputProps {
  /** A dateKey ("YYYY-MM-DD"), or `''` when there is no date yet. */
  value: string;
  /** Called with a dateKey, or `''` while the entry is incomplete or impossible. */
  onChange: (dateKey: string) => void;
  id?: string;
  name?: string;
  /** Bounds the calendar picker, exactly as the native attribute does. */
  min?: string;
  max?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  onBlur?: () => void;
  'aria-invalid'?: true | undefined;
  'aria-describedby'?: string;
}

export function DateInput({
  value,
  onChange,
  id,
  name,
  min,
  max,
  disabled,
  autoFocus,
  className,
  onBlur,
  ...aria
}: DateInputProps) {
  const [text, setText] = useState(() => toDisplayDate(value));
  const textRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  /**
   * The last dateKey this component handed out.
   *
   * Without it, echoing the prop back into the text box would fight the person typing:
   * every keystroke below eight digits reports `''`, and re-rendering from `''` would wipe
   * the partial entry. Only a value that did *not* come from here — a `form.reset`, a
   * sibling's details being copied in — is allowed to overwrite what is on screen.
   */
  const emitted = useRef(value);

  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    setText(toDisplayDate(value));
  }, [value]);

  function commit(display: string) {
    setText(display);
    const dateKey = fromDisplayDate(display);
    emitted.current = dateKey;
    onChange(dateKey);
  }

  /**
   * Drops a half-typed entry once the field is left, so the box shows what was captured.
   *
   * An incomplete or impossible entry reports as `''` while it is being typed, which is
   * correct — but on a field that is allowed to be empty, `''` means "no date". Leaving
   * "16-09-202" on screen would then claim a date the record does not have, and there is
   * no error to explain the gap the way a required field's validation once did. Blanking
   * it is the only outcome the display and the stored value agree on.
   */
  function handleBlur() {
    if (text !== '' && fromDisplayDate(text) === '') setText('');
    onBlur?.();
  }

  function openPicker(event: MouseEvent<HTMLButtonElement>) {
    // Several of these fields sit inside a <label>, and a click anywhere in a label is
    // forwarded to the control it labels — the text box — which would steal focus back
    // from the calendar the moment it opened.
    event.preventDefault();

    // showPicker() is the only way to open the platform calendar from another element. It
    // throws where there is no picker to show; the date can still be typed by hand, so the
    // fallback is to put the caret in the field rather than to report anything.
    try {
      pickerRef.current?.showPicker();
    } catch {
      textRef.current?.focus();
    }
  }

  return (
    <div className={cn('relative', className)}>
      <input
        ref={textRef}
        id={id}
        name={name}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={PLACEHOLDER}
        // Eight digits plus two hyphens. Stops a paste from outrunning the mask.
        maxLength={10}
        value={text}
        onChange={(event) => commit(maskDate(event.target.value))}
        onBlur={handleBlur}
        className={cn(
          'h-10 w-full rounded-md border border-slate-300 bg-white py-0 pl-3 pr-10 text-sm text-slate-900',
          'placeholder:text-slate-400 disabled:bg-slate-100 aria-[invalid=true]:border-red-500',
        )}
        {...aria}
      />

      <button
        type="button"
        onClick={openPicker}
        disabled={disabled}
        // The text box is the control; this only opens the calendar, so it is skipped in
        // the tab order rather than sitting between every date field and the next one.
        tabIndex={-1}
        aria-label="Open calendar"
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-slate-400 hover:text-slate-600 disabled:text-slate-300"
      >
        <Calendar className="h-4 w-4" aria-hidden />
      </button>

      {/*
        Kept in the layout but invisible: showPicker() refuses to open for an element that
        is not rendered, so `hidden` or `display:none` would leave the button doing nothing.
      */}
      <input
        ref={pickerRef}
        type="date"
        tabIndex={-1}
        aria-hidden
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(event) => commit(toDisplayDate(event.target.value))}
        className="pointer-events-none absolute bottom-0 right-2 h-px w-px opacity-0"
      />
    </div>
  );
}
