import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateRecord } from '../domain/validation.js';

let current: Record<string, unknown>;
let ackRows: { code: string; fieldPath: string; acknowledgedAt: Date; acknowledgedBy: { name: string } }[] = [];
let ackEvents: { eventType: string; after: unknown; timestamp: Date }[] = [];
const upsert = vi.fn();
const auditCreate = vi.fn();
const empty = () => ({ findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) });

vi.mock('../db/client.js', () => ({
  prisma: {
    pORecord: { findFirst: vi.fn(async () => current) },
    validationAck: { findMany: vi.fn(async () => ackRows), upsert: (...a: unknown[]) => upsert(...a) },
    auditEvent: { create: (...a: unknown[]) => auditCreate(...a), findMany: vi.fn(async () => ackEvents) },
    fieldExtraction: empty(),
    submission: empty(),
    sapResult: empty(),
    extractionRun: empty(),
  },
}));

const { acknowledgeWarnings } = await import('./records.js');
const uploader = { id: 'u1', role: 'UPLOADER' as const, name: 'Uploader' };

const line = {
  id: 'l1', headerId: 'h1', lineNumber: 1, materialCode: 'MAT-1', customerMaterialNumber: null,
  description: 'Widget', quantity: '10', uom: 'EA', unitPrice: '5.00', lineNetValue: '50.00',
  deliveryDate: null, plant: null,
};
const header = (over: Record<string, unknown> = {}) => ({
  id: 'h1', recordId: 'r1', poNumber: 'PO-1', poDate: '2026-09-01', customerName: 'Acme',
  customerCode: 'C-1', shipTo: null, billTo: null, requestedDeliveryDate: '2026-10-01',
  currency: 'EUR', paymentTerms: null, incoterms: null, poTotalValue: '50.00', contact: null,
  updatedAt: new Date(), lineItems: [line], ...over,
});
const record = (h: Record<string, unknown> = {}, status = 'NEEDS_REVIEW') => ({
  id: 'r1', correlationId: 'PO-R1', status, currentAttempt: 0, uploadedById: 'u1', header: header(h), sourceDocument: null,
});

// Two warnings (the total, and a date that could be read two ways) and nothing blocking.
const twoWarnings = { poTotalValue: '500.00', poDate: '03/04/2026' };
const audited = () => auditCreate.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  ackRows = [];
  ackEvents = [];
  current = record(twoWarnings);
});

describe('accepting warnings (FR-6.9)', () => {
  it('accepts one warning, recording it as the server words it — not as the client sent it', async () => {
    await acknowledgeWarnings(uploader, 'r1', { code: 'TOTAL_MISMATCH', fieldPath: 'header.poTotalValue' });

    expect(upsert).toHaveBeenCalledTimes(1);
    const [event] = audited();
    expect(event).toMatchObject({ eventType: 'WARNING_ACKNOWLEDGED', actorId: 'u1' });
    expect(event.after).toEqual({
      code: 'TOTAL_MISMATCH',
      fieldPath: 'header.poTotalValue',
      message: 'Line items sum to 50.00 but the PO total reads 500.00.',
    });
  });

  it('"all" accepts every warning currently raised, and only those', async () => {
    await acknowledgeWarnings(uploader, 'r1', 'all');

    expect(audited().map((e) => e.after.code).sort()).toEqual(['AMBIGUOUS_DATE', 'TOTAL_MISMATCH']);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('skips a warning that is already accepted as it now reads', async () => {
    const [total] = (await validateRecord(current.header as never)).filter((i) => i.code === 'TOTAL_MISMATCH');
    ackRows = [{ code: 'TOTAL_MISMATCH', fieldPath: 'header.poTotalValue', acknowledgedAt: new Date(), acknowledgedBy: { name: 'x' } }];
    ackEvents = [{ eventType: 'WARNING_ACKNOWLEDGED', after: { code: 'TOTAL_MISMATCH', fieldPath: 'header.poTotalValue', message: total!.message }, timestamp: new Date() }];

    await acknowledgeWarnings(uploader, 'r1', 'all');
    expect(audited().map((e) => e.after.code)).toEqual(['AMBIGUOUS_DATE']);

    auditCreate.mockClear();
    await acknowledgeWarnings(uploader, 'r1', { code: 'TOTAL_MISMATCH', fieldPath: 'header.poTotalValue' });
    expect(auditCreate).not.toHaveBeenCalled(); // re-accepting the same thing writes nothing
  });

  it('accepts a warning again when it has changed since the last acceptance', async () => {
    ackRows = [{ code: 'TOTAL_MISMATCH', fieldPath: 'header.poTotalValue', acknowledgedAt: new Date(), acknowledgedBy: { name: 'x' } }];
    ackEvents = [{ eventType: 'WARNING_ACKNOWLEDGED', after: { code: 'TOTAL_MISMATCH', fieldPath: 'header.poTotalValue', message: 'Line items sum to 50.00 but the PO total reads 7.00.' }, timestamp: new Date() }];

    await acknowledgeWarnings(uploader, 'r1', { code: 'TOTAL_MISMATCH', fieldPath: 'header.poTotalValue' });
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it('will not "accept" a blocking issue', async () => {
    current = record({ currency: 'EURO' });
    await expect(
      acknowledgeWarnings(uploader, 'r1', { code: 'INVALID_CURRENCY', fieldPath: 'header.currency' }),
    ).rejects.toMatchObject({ status: 400, code: 'NOT_A_WARNING' });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a warning that is not raised (made up, or already fixed)', async () => {
    await expect(
      acknowledgeWarnings(uploader, 'r1', { code: 'MADE_UP', fieldPath: 'header.nothing' }),
    ).rejects.toMatchObject({ status: 409, code: 'WARNING_NOT_RAISED' });
    expect(upsert).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it.each(['APPROVED', 'SENT_TO_SAP', 'SO_CREATED', 'CANCELLED', 'DRAFT'])('is only for review: refused on a %s record', async (status) => {
    current = record(twoWarnings, status);
    await expect(acknowledgeWarnings(uploader, 'r1', 'all')).rejects.toMatchObject({ status: 409, code: 'NOT_EDITABLE' });
    expect(upsert).not.toHaveBeenCalled();
  });
});
