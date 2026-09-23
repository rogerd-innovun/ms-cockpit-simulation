import { Field } from './Field';
import type { FieldProvenance, LineItem, ValidationIssue } from '../lib/types';

const COLUMNS: { key: keyof LineItem; label: string; width?: string; num?: boolean }[] = [
  { key: 'materialCode', label: 'Material', width: '116px' },
  { key: 'customerMaterialNumber', label: 'Cust. mat.', width: '104px' },
  { key: 'description', label: 'Description', width: '228px' },
  { key: 'quantity', label: 'Qty', width: '68px', num: true },
  { key: 'uom', label: 'UOM', width: '58px' },
  { key: 'unitPrice', label: 'Unit price', width: '92px', num: true },
  { key: 'lineNetValue', label: 'Net value', width: '100px', num: true },
  { key: 'deliveryDate', label: 'Delivery', width: '100px' },
  { key: 'plant', label: 'Plant', width: '68px' },
];

interface Props {
  lines: LineItem[];
  fields: Map<string, FieldProvenance>;
  issues: ValidationIssue[];
  threshold: number;
  editable: boolean;
  onEdit: (lineNumber: number, key: string, value: string | null) => void;
  onAdd: () => void;
  onDelete: (lineNumber: number) => void;
}

/** FR-5.1 / FR-7.5 — one header, many lines, all editable during review. */
export function LineItemsTable({
  lines,
  fields,
  issues,
  threshold,
  editable,
  onEdit,
  onAdd,
  onDelete,
}: Props) {
  // A reviewer's first instinct is to check the lines add up to the PO total.
  const netSum = lines.reduce((sum, l) => {
    const n = Number.parseFloat((l.lineNetValue ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? sum + n : sum;
  }, 0);

  const flagged = (path: string) =>
    issues.some((i) => i.fieldPath === path && (i.severity === 'BLOCKING' || !i.acknowledged)) ||
    Boolean(fields.get(path)?.lowConfidence && !fields.get(path)?.editedAt);

  return (
    <section className="sec">
      <div className="sec-head">
        <h2>Line items</h2>
        <span className="count-chip tnum">{lines.length}</span>
        <div className="spacer" />
        {netSum > 0 && (
          <span className="cap tnum" title="Sum of the net values below">
            net {netSum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        )}
        {editable && <button className="sm" onClick={onAdd}>Add line</button>}
      </div>

      <div className="lines">
        <table className="lines">
          <thead>
            <tr>
              <th style={{ width: 30 }}>#</th>
              {COLUMNS.map((c) => (
                <th key={c.key} style={{ width: c.width }} className={c.num ? 'num' : undefined}>
                  {c.label}
                </th>
              ))}
              {editable && <th style={{ width: 30 }} aria-label="Remove" />}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                <td className="rownum">{line.lineNumber}</td>
                {COLUMNS.map((c) => {
                  const path = `line.${line.lineNumber}.${c.key}`;
                  return (
                    <td key={c.key} className={flagged(path) ? 'cell-flag' : undefined}>
                      <Field
                        compact
                        label={c.label}
                        fieldPath={path}
                        value={(line[c.key] as string | null) ?? null}
                        provenance={fields.get(path)}
                        issues={issues}
                        threshold={threshold}
                        disabled={!editable}
                        onCommit={(v) => onEdit(line.lineNumber, c.key, v)}
                      />
                    </td>
                  );
                })}
                {editable && (
                  <td>
                    <button
                      className="quiet sm"
                      title={`Remove line ${line.lineNumber}`}
                      aria-label={`Remove line ${line.lineNumber}`}
                      onClick={() => onDelete(line.lineNumber)}
                    >
                      ✕
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {lines.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length + 2} className="empty">
                  No line items. A Sales Order needs at least one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
