import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateRecord } from '../domain/validation.js';

// Two approvers click Approve in the same second. Both read the record as NEEDS_REVIEW and
// both pass validation; the database is what separates them. These tests stand in for
// the database's answer to the conditional update that claims the record — and, for the
// warning gate, for what has been accepted on the record.

const header = {
  id: 'h1', recordId: 'r1', poNumber: 'PO-1', poDate: '2026-09-01', customerName: 'Acme',
  customerCode: 'C-1', shipTo: null, billTo: null, requestedDeliveryDate: '2026-10-01',
  currency: 'EUR', paymentTerms: null, incoterms: null, poTotalValue: '50.00', contact: null,
  updatedAt: new Date(),
  lineItems: [
    { id: 'l1', headerId: 'h1', lineNumber: 1, materialCode: 'MAT-1', customerMaterialNumber: null,
      description: 'Widget', quantity: '10', uom: 'EA', unitPrice: '5.00', lineNetValue: '50.00',
      deliveryDate: null, plant: null },
  ],
};
const baseRecord = {
  id: 'r1', correlationId: 'PO-R1', status: 'NEEDS_REVIEW', currentAttempt: 0,
  uploadedById: 'uploader-1', header, sourceDocument: null,
};

let current: typeof baseRecord = baseRecord;
let ackRows: { code: string; fieldPath: string; acknowledgedAt: Date; acknowledgedBy: { name: string } }[] = [];
let ackEvents: { eventType: string; after: unknown; timestamp: Date }[] = [];

const tx = {
  pORecord: { updateMany: vi.fn() },
  submission: { create: vi.fn() },
};
const auditCreate = vi.fn();
const empty = () => ({ findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) });
const submitToSap = vi.fn().mockResolvedValue(undefined);

vi.mock('../db/client.js', () => ({
  prisma: {
    pORecord: { findFirst: vi.fn(async () => current) },
    $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    auditEvent: { create: (...a: unknown[]) => auditCreate(...a), findMany: vi.fn(async () => ackEvents) },
    validationAck: { findMany: vi.fn(async () => ackRows) },
    fieldExtraction: empty(),
    submission: empty(),
    sapResult: empty(),
    extractionRun: empty(),
  },
}));
vi.mock('./sap/outbound.js', () => ({ submitToSap: (...a: unknown[]) => submitToSap(...a) }));

const { approveRecord } = await import('./records.js');
const approver = { id: 'approver-1', role: 'APPROVER' as const, name: 'Approver' };

beforeEach(() => {
  vi.clearAllMocks();
  current = baseRecord;
  ackRows = [];
  ackEvents = [];
  tx.pORecord.updateMany.mockResolvedValue({ count: 1 });
});

describe('approving (FR-7.9, FR-7.10)', () => {
  it('claims the record only if it is still in the state this request validated', async () => {
    await approveRecord(approver, 'r1');

    expect(tx.pORecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r1', status: 'NEEDS_REVIEW', currentAttempt: 0 },
        data: expect.objectContaining({ status: 'APPROVED', currentAttempt: 1 }),
      }),
    );
    expect(tx.submission.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ recordId: 'r1', attempt: 1 }) }),
    );
    expect(submitToSap).toHaveBeenCalledWith('r1');
  });

  it('answers the approver who lost the race with 409, and does nothing else', async () => {
    tx.pORecord.updateMany.mockResolvedValue({ count: 0 }); // the other request got there first

    await expect(approveRecord(approver, 'r1')).rejects.toMatchObject({
      status: 409,
      code: 'CONCURRENT_UPDATE',
    });

    expect(tx.submission.create).not.toHaveBeenCalled(); // no second submission row
    expect(auditCreate).not.toHaveBeenCalled(); // no second "approved" in the audit trail
    expect(submitToSap).not.toHaveBeenCalled(); // no second file for SAP
  });
});

describe('warnings must be accepted before approval (FR-6.1)', () => {
  // The total on the page reads 500 while the lines come to 50: a warning, not a block.
  const mismatched = { ...baseRecord, header: { ...header, poTotalValue: '500.00' } };
  const warningOf = async (rec: typeof baseRecord) => (await validateRecord(rec.header as never)).find((i) => i.code === 'TOTAL_MISMATCH')!;
  const accepted = (message: string, by = 'Ada Approver') => {
    ackRows = [{ code: 'TOTAL_MISMATCH', fieldPath: 'header.poTotalValue', acknowledgedAt: new Date('2026-10-01T12:00:00Z'), acknowledgedBy: { name: by } }];
    ackEvents = [{ eventType: 'WARNING_ACKNOWLEDGED', after: { code: 'TOTAL_MISMATCH', fieldPath: 'header.poTotalValue', message }, timestamp: new Date('2026-10-01T12:00:00Z') }];
  };

  it('refuses a record with a warning nobody has accepted, naming it, and changes nothing', async () => {
    current = mismatched;
    const err = await approveRecord(approver, 'r1').catch((e) => e);

    expect(err).toMatchObject({ status: 400, code: 'WARNINGS_UNACKNOWLEDGED' });
    expect(err.details.issues).toEqual([expect.objectContaining({ code: 'TOTAL_MISMATCH', fieldPath: 'header.poTotalValue' })]);
    expect(tx.pORecord.updateMany).not.toHaveBeenCalled();
    expect(tx.submission.create).not.toHaveBeenCalled();
    expect(submitToSap).not.toHaveBeenCalled();
  });

  it('goes ahead once the warning has been accepted as it now reads', async () => {
    current = mismatched;
    accepted((await warningOf(mismatched)).message);

    await approveRecord(approver, 'r1');

    expect(tx.submission.create).toHaveBeenCalledTimes(1);
    expect(submitToSap).toHaveBeenCalledWith('r1');
  });

  it('refuses again when an edit has changed what the warning says since it was accepted', async () => {
    accepted((await warningOf(mismatched)).message); // accepted when the total read 500.00 …
    current = { ...baseRecord, header: { ...header, poTotalValue: '99999.00' } }; // … then it was edited

    await expect(approveRecord(approver, 'r1')).rejects.toMatchObject({ code: 'WARNINGS_UNACKNOWLEDGED' });
    expect(tx.submission.create).not.toHaveBeenCalled();
  });

  it('records which warnings stood, who accepted them and when, in the approved snapshot (FR-6.9)', async () => {
    current = mismatched;
    accepted((await warningOf(mismatched)).message, 'Ada Approver');

    await approveRecord(approver, 'r1');

    const snapshot = tx.submission.create.mock.calls[0]![0].data.approvedSnapshot;
    expect(snapshot.acceptedWarnings).toEqual([
      expect.objectContaining({
        code: 'TOTAL_MISMATCH',
        fieldPath: 'header.poTotalValue',
        acceptedBy: 'Ada Approver',
        acceptedAt: '2026-10-01T12:00:00.000Z',
      }),
    ]);
  });

  it('a clean record has nothing to accept and an empty list in the snapshot', async () => {
    await approveRecord(approver, 'r1');
    expect(tx.submission.create.mock.calls[0]![0].data.approvedSnapshot.acceptedWarnings).toEqual([]);
  });

  it('a blocking issue is still refused first, with its own code', async () => {
    current = { ...mismatched, header: { ...mismatched.header, currency: 'EURO' } };
    await expect(approveRecord(approver, 'r1')).rejects.toMatchObject({ code: 'VALIDATION_BLOCKED' });
  });
});
