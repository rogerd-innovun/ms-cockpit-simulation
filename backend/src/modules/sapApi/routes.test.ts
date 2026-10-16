import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// What SAP sees and what it can do: fetch the orders waiting for it, and post an answer that is
// handled by the same rules as a result file. The rules themselves are tested with the watcher;
// here the question is what each call returns.

const KEY = 'sap-test-key-0123456789-abcdefghij';

let records: Record<string, unknown>[] = [];
const prismaMock = {
  pORecord: {
    findMany: vi.fn(async () => records),
    findFirst: vi.fn(async (args: { where: { correlationId: string } }) => records.find((r) => r.correlationId === args.where.correlationId) ?? null),
  },
};
const ingest = vi.fn();
vi.mock('../../db/client.js', () => ({ prisma: prismaMock }));
vi.mock('../../services/sap/resultWatcher.js', () => ({ ingestApiResult: (...a: unknown[]) => ingest(...a) }));

async function makeApp() {
  process.env.SAP_API_KEY = KEY;
  vi.resetModules();
  const { sapApiRouter } = await import('./routes.js');
  const { errorHandler } = await import('../../middleware/error.js');
  const app = express();
  app.use(express.json());
  app.use('/sap', sapApiRouter);
  app.use(errorHandler);
  return app;
}
const get = (app: express.Express, path: string) => request(app).get(`/sap${path}`).set('X-API-Key', KEY);
const post = (app: express.Express, path: string, body: unknown) => request(app).post(`/sap${path}`).set('X-API-Key', KEY).send(body as object);

const record = (over: Record<string, unknown> = {}) => ({
  id: 'r1', correlationId: 'PO-AAA', status: 'SENT_TO_SAP', currentAttempt: 1, sentToSapAt: new Date(),
  header: {
    poNumber: 'APX-1', poDate: 'Sep 18, 2026', customerCode: 'C-1', customerName: 'Apex', shipTo: 'Dock 4', billTo: null,
    currency: 'usd ', requestedDeliveryDate: '18/10/2026', paymentTerms: 'Net 30', incoterms: 'FOB', poTotalValue: '1.234,56',
    lineItems: [
      { lineNumber: 2, materialCode: 'M-2', customerMaterialNumber: null, description: 'Bolt', quantity: '10', uom: 'EA', unitPrice: '1,50', lineNetValue: '15,00', deliveryDate: null, plant: '1000' },
      { lineNumber: 1, materialCode: 'M-1', customerMaterialNumber: 'X9', description: 'Nut', quantity: '1000', uom: 'EA', unitPrice: '1.219,56', lineNetValue: '1.219,56', deliveryDate: '20 Oct 2026', plant: '1000' },
    ],
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  records = [];
});

describe('GET /orders', () => {
  it('needs the key', async () => {
    const app = await makeApp();
    expect((await request(app).get('/sap/orders')).status).toBe(401);
  });

  it('lists the orders waiting for SAP, in the same formats as the file: ISO dates, "." decimals, lines in order', async () => {
    records = [record()];
    const res = await get(await makeApp(), '/orders');
    expect(res.status).toBe(200);
    expect(res.body.problems).toEqual([]);
    const o = res.body.orders[0];
    expect(o).toMatchObject({ correlationId: 'PO-AAA', attempt: 1 });
    expect(o.header).toMatchObject({
      poNumber: 'APX-1', poDate: '2026-09-18', requestedDeliveryDate: '2026-10-18', currency: 'USD', poTotalValue: '1234.56',
    });
    expect(o.lines.map((l: { lineNumber: number }) => l.lineNumber)).toEqual([1, 2]);
    expect(o.lines[0]).toMatchObject({ quantity: '1000', unitPrice: '1219.56', deliveryDate: '2026-10-20', customerMaterialNumber: 'X9' });
    expect(o.lines[1]).toMatchObject({ quantity: '10', unitPrice: '1.50', deliveryDate: '' });
  });

  it('asks only for orders that are with SAP', async () => {
    await get(await makeApp(), '/orders?limit=5');
    expect(prismaMock.pORecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'SENT_TO_SAP', deletedAt: null }, take: 5 }),
    );
  });

  it('reports an order it cannot write instead of hiding it, and still returns the rest', async () => {
    const bad = record({ correlationId: 'PO-BAD' });
    (bad.header as { poDate: string }).poDate = 'sometime soon';
    records = [bad, record()];
    const res = await get(await makeApp(), '/orders');
    expect(res.body.orders.map((o: { correlationId: string }) => o.correlationId)).toEqual(['PO-AAA']);
    expect(res.body.problems).toEqual([{ correlationId: 'PO-BAD', error: expect.stringContaining('not a valid date') }]);
  });

  it('rejects a silly limit', async () => {
    expect((await get(await makeApp(), '/orders?limit=0')).status).toBe(400);
    expect((await get(await makeApp(), '/orders?limit=500')).status).toBe(400);
  });
});

describe('GET /orders/:correlationId', () => {
  it('returns one order', async () => {
    records = [record()];
    const res = await get(await makeApp(), '/orders/PO-AAA');
    expect(res.status).toBe(200);
    expect(res.body.correlationId).toBe('PO-AAA');
  });
  it('404 for one that does not exist, and 409 for one that is not waiting for SAP', async () => {
    records = [record({ correlationId: 'PO-DONE', status: 'SO_CREATED' })];
    const app = await makeApp();
    expect((await get(app, '/orders/PO-NOPE')).status).toBe(404);
    const done = await get(app, '/orders/PO-DONE');
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe('NOT_WAITING_FOR_SAP');
  });
});

describe('POST /results', () => {
  it('applies a success and says so', async () => {
    ingest.mockResolvedValue('applied');
    const res = await post(await makeApp(), '/results', { correlationId: 'PO-AAA', attempt: 1, status: 'SUCCESS', soNumber: '4500123456' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true, applied: true, outcome: 'applied' });
    expect(ingest).toHaveBeenCalledWith({
      correlationId: 'PO-AAA', attempt: 1, outcome: 'SUCCESS', soNumber: '4500123456', errorCode: null, errorMessage: null, sapTimestamp: null,
    });
  });

  it('understands ABAP-style field names and any case of the status', async () => {
    ingest.mockResolvedValue('applied');
    const res = await post(await makeApp(), '/results', {
      CORRELATION_ID: 'PO-AAA', ATTEMPT: '2', STATUS: 'error', ERROR_CODE: 'PRICING_ERROR', ERROR_MESSAGE: 'No condition record', SAP_TIMESTAMP: '2026-10-05T10:00:00Z',
    });
    expect(res.status).toBe(200);
    expect(ingest).toHaveBeenCalledWith({
      correlationId: 'PO-AAA', attempt: 2, outcome: 'ERROR', soNumber: null, errorCode: 'PRICING_ERROR', errorMessage: 'No condition record', sapTimestamp: '2026-10-05T10:00:00Z',
    });
  });

  it('refuses a success with no Sales Order number, the same as a result file', async () => {
    const res = await post(await makeApp(), '/results', { correlationId: 'PO-AAA', status: 'SUCCESS' });
    expect(res.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('refuses a body with no correlation ID or an unknown status', async () => {
    const app = await makeApp();
    expect((await post(app, '/results', { status: 'ERROR' })).status).toBe(400);
    expect((await post(app, '/results', { correlationId: 'PO-AAA', status: 'MAYBE' })).status).toBe(400);
  });

  it('treats the same answer sent twice as done, not as a problem', async () => {
    ingest.mockResolvedValue('duplicate');
    const res = await post(await makeApp(), '/results', { correlationId: 'PO-AAA', attempt: 1, status: 'SUCCESS', soNumber: '4500123456' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true, applied: false, duplicate: true });
  });

  it('says plainly when an answer was kept but not applied, or matches nothing', async () => {
    const app = await makeApp();
    const body = { correlationId: 'PO-AAA', attempt: 1, status: 'SUCCESS', soNumber: '4500123456' };
    ingest.mockResolvedValueOnce('ignored-stale');
    expect(await post(app, '/results', body)).toMatchObject({ status: 409, body: { error: { code: 'STALE_ATTEMPT' } } });
    ingest.mockResolvedValueOnce('ignored-not-waiting');
    expect(await post(app, '/results', body)).toMatchObject({ status: 409, body: { error: { code: 'NOT_WAITING_FOR_RESULT' } } });
    ingest.mockResolvedValueOnce('unmatched');
    expect(await post(app, '/results', body)).toMatchObject({ status: 404, body: { error: { code: 'UNKNOWN_CORRELATION_ID' } } });
  });

  it('applies a late answer the same way as an ordinary one', async () => {
    ingest.mockResolvedValue('applied-late');
    const res = await post(await makeApp(), '/results', { correlationId: 'PO-AAA', attempt: 1, status: 'SUCCESS', soNumber: '4500123456' });
    expect(res.body).toMatchObject({ applied: true, outcome: 'applied-late' });
  });
});

describe('GET /ping', () => {
  it('answers when the key is right and touches no order', async () => {
    const res = await get(await makeApp(), '/ping');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(prismaMock.pORecord.findMany).not.toHaveBeenCalled();
  });
});
