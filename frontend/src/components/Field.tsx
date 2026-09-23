import { useEffect, useRef, useState } from 'react';
import { ProofMark } from './ProofMark';
import { toneClass } from '../lib/status';
import type { FieldProvenance, ValidationIssue } from '../lib/types';

interface Props {
  label: string;
  fieldPath: string;
  value: string | null;
  provenance?: FieldProvenance;
  issues: ValidationIssue[];
  threshold: number;
  disabled?: boolean;
  compact?: boolean;
  cursor?: boolean;
  onCommit: (value: string | null) => void;
}

/**
 * FR-7.2 — a field shows four things at once: its value, how sure the model was,
 * whether a human changed it, and whether validation objects. FR-7.6 — the
 * original extracted value stays visible next to an edited one, and here it is
 * also clickable, so putting the model's reading back is one action.
 */
export function Field({
  label,
  fieldPath,
  value,
  provenance,
  issues,
  threshold,
  disabled,
  compact,
  cursor,
  onCommit,
}: Props) {
  const [draft, setDraft] = useState(value ?? '');
  const dirty = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Accept server updates unless the user is mid-edit on this field.
  useEffect(() => {
    if (!dirty.current) setDraft(value ?? '');
  }, [value]);

  // The keyboard walk only *marks* this field — it deliberately does not focus the
  // input, or J and K would type letters instead of moving. Enter focuses to edit.

  const mine = issues.filter((i) => i.fieldPath === fieldPath);
  const blocking = mine.find((i) => i.severity === 'BLOCKING');
  const warning = mine.find((i) => i.severity === 'WARNING' && !i.acknowledged);
  const edited = Boolean(provenance?.editedAt);
  const low = Boolean(provenance?.lowConfidence) && !edited;

  const commit = () => {
    dirty.current = false;
    const next = draft.trim() === '' ? null : draft.trim();
    if (next !== value) onCommit(next);
  };

  const input = (
    <input
      id={fieldPath}
      ref={inputRef}
      value={draft}
      disabled={disabled}
      aria-invalid={Boolean(blocking)}
      aria-label={compact ? label : undefined}
      title={compact ? (blocking?.message ?? warning?.message ?? undefined) : undefined}
      placeholder={compact ? '' : '—'}
      onChange={(e) => {
        dirty.current = true;
        setDraft(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          dirty.current = false;
          setDraft(value ?? '');
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );

  // In a line-items cell there is no room for label, mark or note — the column
  // header names it and the row tint flags it.
  if (compact) return input;

  const tone = blocking ? 't-crit' : warning || low ? 't-warn' : edited ? 't-info' : '';

  return (
    <div
      className={`fieldrow ${tone} ${blocking || warning || low ? 'flag' : ''} ${cursor ? 'cursor' : ''}`}
      data-fieldpath={fieldPath}
    >
      <span className="gut">
        <ProofMark provenance={provenance} threshold={threshold} blocking={Boolean(blocking)} />
      </span>
      <div className="body">
        <label htmlFor={fieldPath}>{label}</label>
        {input}
        {blocking && <div className={`note ${toneClass('crit')}`}>{blocking.message}</div>}
        {!blocking && warning && <div className={`note ${toneClass('warn')}`}>{warning.message}</div>}
        {!blocking && !warning && edited && provenance?.extractedValue && (
          <div className="was">
            <span>model read</span>
            <button
              type="button"
              className="restore"
              disabled={disabled}
              title="Put the model's original reading back"
              onClick={() => {
                dirty.current = false;
                setDraft(provenance.extractedValue ?? '');
                onCommit(provenance.extractedValue ?? null);
              }}
            >
              <s>{provenance.extractedValue}</s>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
