import { describe, expect, it } from 'vitest';
import { markAcknowledged } from './acknowledgement.js';
import type { ValidationIssue } from './validation.js';

const warning = (message: string, code = 'TOTAL_MISMATCH', fieldPath = 'header.poTotalValue'): ValidationIssue => ({
  code, severity: 'WARNING', fieldPath, message,
});
const blocking = (): ValidationIssue => ({ code: 'REQUIRED_MISSING', severity: 'BLOCKING', fieldPath: 'header.poNumber', message: 'PO Number is required.' });
const row = (code = 'TOTAL_MISMATCH', fieldPath = 'header.poTotalValue') => ({ code, fieldPath });
type Event = { eventType: string; after: unknown; timestamp: Date };
const accepted = (message: string, minute: number, code = 'TOTAL_MISMATCH', fieldPath = 'header.poTotalValue'): Event => ({
  eventType: 'WARNING_ACKNOWLEDGED',
  after: { code, fieldPath, message },
  timestamp: new Date(Date.UTC(2026, 9, 1, 12, minute)),
});
const flag = (issues: ValidationIssue[], acks: ReturnType<typeof row>[], audit: Event[]) =>
  markAcknowledged(issues, acks, audit).map((i) => i.acknowledged);

describe('which warnings count as accepted (FR-6.9)', () => {
  const w = warning('Line items sum to 50.00 but the PO total reads 500.00.');

  it('a warning nobody has accepted is not accepted', () => {
    expect(flag([w], [], [])).toEqual([false]);
  });

  it('is accepted when the same warning, worded the same, was accepted', () => {
    expect(flag([w], [row()], [accepted(w.message, 1)])).toEqual([true]);
  });

  it('lapses when an edit changes the figures, even though the code and field are unchanged', () => {
    const changed = warning('Line items sum to 50.00 but the PO total reads 99999.00.');
    expect(flag([changed], [row()], [accepted(w.message, 1)])).toEqual([false]);
  });

  it('can be accepted again after it has lapsed, and the later acceptance is what counts', () => {
    const changed = warning('Line items sum to 50.00 but the PO total reads 99999.00.');
    const audit = [accepted(w.message, 1), accepted(changed.message, 5)];
    expect(flag([changed], [row()], audit)).toEqual([true]);
    expect(flag([w], [row()], audit)).toEqual([false]); // and the old reading is no longer the accepted one
  });

  it('an acceptance with no wording on record (made before wording was kept) holds on code and field', () => {
    expect(flag([w], [row()], [])).toEqual([true]);
    expect(flag([w], [row()], [{ eventType: 'WARNING_ACKNOWLEDGED', after: null, timestamp: new Date() }])).toEqual([true]);
  });

  it('is per warning: accepting one field does not accept another', () => {
    const a = warning('Date is read day first.', 'AMBIGUOUS_DATE', 'header.poDate');
    expect(flag([w, a], [row()], [accepted(w.message, 1)])).toEqual([true, false]);
  });

  it('a blocking issue is never accepted, whatever rows exist', () => {
    expect(flag([blocking()], [row('REQUIRED_MISSING', 'header.poNumber')], [])).toEqual([false]);
  });

  it('ignores other kinds of audit events', () => {
    const other = { eventType: 'FIELD_EDITED', after: { code: w.code, fieldPath: w.fieldPath, message: 'x' }, timestamp: new Date() };
    expect(flag([w], [row()], [other])).toEqual([true]);
  });
});
