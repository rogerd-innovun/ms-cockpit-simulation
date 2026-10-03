import { beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in for the database: `current` is the record the service will read, and the
// spies show what it wrote. These tests are about what is written, not about Postgres.
let current: Record<string, unknown>;
const update = vi.fn();
const auditCreate = vi.fn();
const duplicateRows = vi.fn();
const empty = () => ({ findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) });

vi.mock('../db/client.js', () => ({
  prisma: {
    pORecord: {
      findFirst: vi.fn(async () => current),
      update: (...a: unknown[]) => update(...a),
    },
    sourceDocument: { findMany: (...a: unknown[]) => duplicateRows(...a) },
    auditEvent: { create: (...a: unknown[]) => auditCreate(...a), findMany: vi.fn().mockResolvedValue([]) },
    fieldExtraction: empty(),
    submission: empty(),
    sapResult: empty(),
    validationAck: empty(),
    extractionRun: empty(),
  },
}));

const { publishRecord, rejectRecord, updateRecordMetadata } = await import('./records.js');

const uploader = { id: 'u1', role: 'UPLOADER' as const, name: 'Uploader' };
const approver = { id: 'a1', role: 'APPROVER' as const, name: 'Approver' };

const draft = (over: Record<string, unknown> = {}) => ({
  id: 'r1', correlationId: 'PO-R1', status: 'DRAFT', currentAttempt: 0,
  vendorHint: 'Northwind', notes: 'first note', header: null,
  sourceDocument: { contentHash: 'hash-1' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue(draft());
  current = draft();
});

describe('draft metadata (FR-2.1)', () => {
  it('changing the notes leaves the vendor hint alone', async () => {
    await updateRecordMetadata(uploader, 'r1', { notes: 'second note' });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0].data).toEqual({ notes: 'second note' });
  });

  it('changing the vendor hint leaves the notes alone', async () => {
    await updateRecordMetadata(uploader, 'r1', { vendorHint: 'Apex' });
    expect(update.mock.calls[0]![0].data).toEqual({ vendorHint: 'Apex' });
  });

  it('an explicit null or empty string clears the field, trimmed as at upload', async () => {
    await updateRecordMetadata(uploader, 'r1', { notes: '   ', vendorHint: null });
    expect(update.mock.calls[0]![0].data).toEqual({ notes: null, vendorHint: null });
    update.mockClear();
    await updateRecordMetadata(uploader, 'r1', { notes: '  padded  ' });
    expect(update.mock.calls[0]![0].data).toEqual({ notes: 'padded' });
  });

  it('writes nothing, and no audit event, when nothing actually changes', async () => {
    await updateRecordMetadata(uploader, 'r1', { vendorHint: 'Northwind', notes: 'first note' });
    await updateRecordMetadata(uploader, 'r1', {});
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('audits the change with before and after (FR-13.1)', async () => {
    await updateRecordMetadata(uploader, 'r1', { vendorHint: 'Apex' });
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0]![0].data).toMatchObject({
      eventType: 'RECORD_UPDATED',
      recordId: 'r1',
      message: 'vendorHint: "Northwind" → "Apex"',
      before: { vendorHint: 'Northwind' },
      after: { vendorHint: 'Apex' },
      actorId: 'u1',
    });
  });

  it('refuses once the record has left Draft', async () => {
    current = draft({ status: 'NEEDS_REVIEW' });
    await expect(updateRecordMetadata(uploader, 'r1', { notes: 'x' })).rejects.toMatchObject({
      status: 400,
      code: 'NOT_EDITABLE',
    });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('sending a record back (FR-7.12)', () => {
  it('records the reason in the audit trail and leaves the uploader notes untouched', async () => {
    current = draft({ status: 'NEEDS_REVIEW', notes: 'uploader note — keep me' });
    await rejectRecord(approver, 'r1', '  Customer code looks wrong  ');

    expect(auditCreate.mock.calls[0]![0].data).toMatchObject({
      eventType: 'APPROVAL_REJECTED',
      message: 'Customer code looks wrong',
    });
    for (const call of update.mock.calls) expect(call[0].data).not.toHaveProperty('notes');
  });
});

describe('publishing a duplicate (FR-3.4)', () => {
  const row = (id: string, correlationId: string, status: string, poNumber: string | null) => ({
    originalFilename: `${id}.pdf`,
    record: { id, correlationId, status, header: poNumber ? { poNumber } : null },
  });

  it('names the records it matches, with their status and PO number', async () => {
    duplicateRows.mockResolvedValue([
      row('x1', 'PO-AAAA1111', 'SO_CREATED', 'PO-77'),
      row('x2', 'PO-BBBB2222', 'NEEDS_REVIEW', null),
    ]);
    const err = await publishRecord(uploader, 'r1').catch((e) => e);

    expect(err).toMatchObject({ status: 409, code: 'DUPLICATE_DOCUMENT' });
    expect(err.message).toContain('PO-AAAA1111 (SO_CREATED)');
    expect(err.message).toContain('PO-BBBB2222 (NEEDS_REVIEW)');
    expect(err.message).toMatch(/reached SAP/);
    expect(err.details.duplicates[0]).toMatchObject({ recordId: 'x1', poNumber: 'PO-77', status: 'SO_CREATED' });
  });

  it('a duplicate that has not reached SAP is a warning, not a block', async () => {
    duplicateRows.mockResolvedValue([row('x2', 'PO-BBBB2222', 'NEEDS_REVIEW', null)]);
    update.mockResolvedValue(draft({ status: 'PUBLISHED' }));
    await expect(publishRecord(uploader, 'r1')).resolves.toMatchObject({ status: 'PUBLISHED' });
  });

  it('goes ahead with a stated reason, and the reason is audited', async () => {
    duplicateRows.mockResolvedValue([row('x1', 'PO-AAAA1111', 'SO_CREATED', 'PO-77')]);
    update.mockResolvedValue(draft({ status: 'PUBLISHED' }));
    await publishRecord(uploader, 'r1', 'Customer re-ordered');
    expect(auditCreate.mock.calls[0]![0].data.message).toContain('Customer re-ordered');
  });
});
