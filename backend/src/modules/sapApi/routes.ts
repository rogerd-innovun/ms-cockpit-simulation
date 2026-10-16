import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { sapApiAuth } from '../../middleware/sapApiAuth.js';
import { OutboundFormatError, buildOutboundJson } from '../../services/sap/csv.js';
import { ingestApiResult } from '../../services/sap/resultWatcher.js';

/**
 * The HTTPS door for SAP (FR-9.13): the same exchange as the folders, over a URL.
 *
 *   GET  /api/integration/sap/orders        the approved orders SAP has not yet answered
 *   GET  /api/integration/sap/orders/:id    one of them, by correlation ID
 *   POST /api/integration/sap/results       SAP's answer: the Sales Order, or why not
 *
 * An order stays on the list until its answer is posted, so SAP can fetch it again if its
 * own job failed halfway. The answer goes through the very rules a result file does.
 */
export const sapApiRouter = Router();
sapApiRouter.use(sapApiAuth);

/** For SAP's side to test the connection and the key without touching any order. */
sapApiRouter.get('/ping', (_req, res) => {
  res.json({ ok: true, system: 'po-cockpit', time: new Date().toISOString() });
});

const recordWithLines = { header: { include: { lineItems: true } } } as const;

sapApiRouter.get('/orders', async (req, res, next) => {
  try {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    const records = await prisma.pORecord.findMany({
      where: { status: 'SENT_TO_SAP', deletedAt: null },
      orderBy: { sentToSapAt: 'asc' },
      take: limit,
      include: recordWithLines,
    });

    const orders: ReturnType<typeof buildOutboundJson>[] = [];
    // An order that cannot be written in SAP's formats is reported, not silently left out,
    // and does not hold up the others.
    const problems: { correlationId: string; error: string }[] = [];
    for (const r of records) {
      if (!r.header) continue;
      try {
        orders.push(buildOutboundJson(r.correlationId, r.currentAttempt, r.header));
      } catch (err) {
        if (!(err instanceof OutboundFormatError)) throw err;
        problems.push({ correlationId: r.correlationId, error: err.message });
      }
    }
    res.json({ orders, problems });
  } catch (err) {
    next(err);
  }
});

sapApiRouter.get('/orders/:correlationId', async (req, res, next) => {
  try {
    const record = await prisma.pORecord.findFirst({
      where: { correlationId: req.params.correlationId!, deletedAt: null },
      include: recordWithLines,
    });
    if (!record) throw notFound('No order has that correlation ID.');
    if (record.status !== 'SENT_TO_SAP' || !record.header) {
      throw conflict(`That order is ${record.status}, not waiting for SAP.`, 'NOT_WAITING_FOR_SAP', { status: record.status });
    }
    res.json(buildOutboundJson(record.correlationId, record.currentAttempt, record.header));
  } catch (err) {
    next(err);
  }
});

/**
 * ABAP's JSON serialisers write field names in capitals with underscores (CORRELATION_ID);
 * other callers write camelCase. Both are accepted, so SAP does not have to rename anything.
 */
const squash = (o: unknown): unknown =>
  o && typeof o === 'object' && !Array.isArray(o)
    ? Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k.replace(/_/g, '').toLowerCase(), v]))
    : o;

const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(max).optional());

const resultBody = z
  .object({
    correlationid: z.string().trim().min(1, 'correlationId is required').max(100),
    attempt: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.coerce.number().int().positive().optional()),
    status: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.enum(['SUCCESS', 'ERROR'])),
    sonumber: optionalText(20),
    errorcode: optionalText(100),
    errormessage: optionalText(2000),
    saptimestamp: optionalText(40),
  })
  .refine((b) => b.status !== 'SUCCESS' || !!b.sonumber, {
    message: 'A SUCCESS answer must carry soNumber.',
    path: ['soNumber'],
  });

sapApiRouter.post('/results', async (req, res, next) => {
  try {
    const b = resultBody.parse(squash(req.body));
    const outcome = await ingestApiResult({
      correlationId: b.correlationid,
      attempt: b.attempt ?? null,
      outcome: b.status,
      soNumber: b.sonumber ?? null,
      errorCode: b.errorcode ?? null,
      errorMessage: b.errormessage ?? null,
      sapTimestamp: b.saptimestamp ?? null,
    });

    switch (outcome) {
      case 'applied':
      case 'applied-late':
        return void res.json({ accepted: true, applied: true, outcome });
      case 'duplicate':
        // The same answer again: nothing to do, and nothing wrong. SAP can stop retrying.
        return void res.json({ accepted: true, applied: false, duplicate: true });
      case 'unmatched':
        throw new AppError(404, `No order has correlation ID ${b.correlationid}.`, 'UNKNOWN_CORRELATION_ID');
      case 'ignored-stale':
        throw new AppError(409, 'That answer is for an earlier attempt of this order, so it was kept on file but not applied.', 'STALE_ATTEMPT');
      case 'ignored-not-waiting':
        throw new AppError(409, 'That order is not waiting for an answer, so this one was kept on file but not applied.', 'NOT_WAITING_FOR_RESULT');
    }
  } catch (err) {
    next(err);
  }
});
