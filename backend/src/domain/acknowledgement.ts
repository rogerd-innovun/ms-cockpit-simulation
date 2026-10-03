import type { ValidationIssue } from './validation.js';

/**
 * FR-6.1 / FR-6.9 — a warning does not stop an approval, but it has to be accepted by a
 * person first. This decides which warnings currently count as accepted.
 *
 * An acceptance is of *this* warning as worded. The wording carries the figures
 * ("Line items sum to 1,234.00 but the PO total reads 5,000.00"), so once a number is
 * edited the warning reads differently and the earlier acceptance lapses — otherwise
 * someone could accept a small discrepancy, change the total to a large one, and approve
 * on the strength of the first look.
 *
 * The wording is kept in the audit event written at acceptance time. Acceptances recorded
 * before that was kept (no message in the event) are honoured on code and field alone.
 */
export interface AckRow {
  code: string;
  fieldPath: string;
}

export interface AckAuditEvent {
  eventType: string;
  after: unknown;
  timestamp: Date;
}

export const ackKey = (code: string, fieldPath: string) => `${code}::${fieldPath}`;

export function markAcknowledged(
  issues: ValidationIssue[],
  acks: AckRow[],
  audit: AckAuditEvent[],
): (ValidationIssue & { acknowledged: boolean })[] {
  const rows = new Set(acks.map((a) => ackKey(a.code, a.fieldPath)));

  // The wording each warning had when it was last accepted; later events win.
  const wording = new Map<string, string>();
  [...audit]
    .filter((e) => e.eventType === 'WARNING_ACKNOWLEDGED')
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .forEach((e) => {
      const after = e.after as { code?: string; fieldPath?: string; message?: string } | null;
      if (after?.code && after.fieldPath && typeof after.message === 'string') {
        wording.set(ackKey(after.code, after.fieldPath), after.message);
      }
    });

  return issues.map((issue) => {
    const key = ackKey(issue.code, issue.fieldPath);
    const accepted =
      issue.severity === 'WARNING' && rows.has(key) && (!wording.has(key) || wording.get(key) === issue.message);
    return { ...issue, acknowledged: accepted };
  });
}
