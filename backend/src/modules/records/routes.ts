import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import { HEADER_FIELDS, LINE_FIELDS } from '../../domain/types.js';
import { STATUS_LABELS, TRANSITIONS } from '../../domain/status.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { requireAuth } from '../../middleware/auth.js';
import * as records from '../../services/records.js';
import { lineParamsSchema, listQuerySchema } from './query.js';
import { loadDocumentContent } from '../../services/storage.js';

export const recordsRouter = Router();
recordsRouter.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES },
});

const actorOf = (req: Parameters<Parameters<Router['get']>[1]>[0]) => ({
  id: req.user!.id,
  role: req.user!.role,
  name: req.user!.name,
});

/**
 * The one shape every record-detail response carries. The review screen types
 * all of them as a single RecordDetail and reads `duplicates` unconditionally,
 * so a route that answered with the bare service payload took the whole page
 * down with it. Built here once rather than spread across a dozen handlers.
 */
async function detailResponse(id: string) {
  const detail = await records.getRecordDetail(id);
  const contentHash = detail.record.sourceDocument?.contentHash;
  return {
    ...detail,
    duplicates: await records.findPoNumberDuplicates(id),
    // Same bytes as another live record (FR-3.4). Upload already reported this, but the
    // UI navigates away from that response; carrying it on the record is what lets the
    // draft screen warn before anyone clicks Publish.
    documentDuplicates: contentHash ? await records.findDuplicates(contentHash, id) : [],
    allowedTransitions: TRANSITIONS[detail.record.status],
    statusLabel: STATUS_LABELS[detail.record.status],
  };
}

// ---- FR-12 worklist -------------------------------------------------------

recordsRouter.get('/', async (req, res, next) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const result = await records.listRecords({
      status: query.status,
      q: query.q,
      uploadedById: query.mine === 'true' ? req.user!.id : undefined,
      take: query.take,
      skip: query.skip,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

recordsRouter.get('/counts', async (_req, res, next) => {
  try {
    res.json(await records.statusCounts());
  } catch (err) {
    next(err);
  }
});

// ---- FR-1 upload ----------------------------------------------------------

recordsRouter.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw badRequest('No file was uploaded.', 'NO_FILE');
    const result = await records.createRecord(actorOf(req), req.file, {
      vendorHint: typeof req.body?.vendorHint === 'string' ? req.body.vendorHint : undefined,
      notes: typeof req.body?.notes === 'string' ? req.body.notes : undefined,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// ---- detail ---------------------------------------------------------------

recordsRouter.get('/:id', async (req, res, next) => {
  try {
    res.json(await detailResponse(req.params.id!));
  } catch (err) {
    next(err);
  }
});

/** FR-1.9 / NFR-3.5 — the PDF is served through an authorised endpoint, never a public path. */
recordsRouter.get('/:id/document', async (req, res, next) => {
  try {
    const record = await prisma.pORecord.findFirst({
      where: { id: req.params.id!, deletedAt: null },
      include: { sourceDocument: true },
    });
    if (!record?.sourceDocument) throw notFound('No document on this record.');
    const buffer = await loadDocumentContent(record.id, record.sourceDocument.storagePath);
    if (!buffer) {
      throw notFound(
        'The PDF for this record is no longer available. It was uploaded before documents were stored durably, and the host has since cleared its disk.',
      );
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${record.sourceDocument.originalFilename.replace(/"/g, '')}"`,
    );
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// ---- FR-2 / FR-3 lifecycle ------------------------------------------------

recordsRouter.patch('/:id', async (req, res, next) => {
  try {
    const body = z
      .object({ vendorHint: z.string().nullable().optional(), notes: z.string().nullable().optional() })
      .parse(req.body);
    await records.updateRecordMetadata(actorOf(req), req.params.id!, body);
    res.json(await detailResponse(req.params.id!));
  } catch (err) {
    next(err);
  }
});

recordsRouter.post('/:id/publish', async (req, res, next) => {
  try {
    const reason = typeof req.body?.overrideReason === 'string' ? req.body.overrideReason : undefined;
    await records.publishRecord(actorOf(req), req.params.id!, reason);
    res.json(await detailResponse(req.params.id!));
  } catch (err) {
    next(err);
  }
});

recordsRouter.delete('/:id', async (req, res, next) => {
  try {
    await records.deleteDraft(actorOf(req), req.params.id!);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

recordsRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    await records.cancelRecord(
      actorOf(req),
      req.params.id!,
      typeof req.body?.reason === 'string' ? req.body.reason : undefined,
    );
    res.json(await detailResponse(req.params.id!));
  } catch (err) {
    next(err);
  }
});

// ---- FR-7 review ----------------------------------------------------------

const fieldUpdateSchema = z.object({
  header: z.record(z.enum(HEADER_FIELDS), z.string().nullable()).optional(),
  lines: z
    .array(
      z.object({
        lineNumber: z.number().int().positive(),
        values: z.record(z.enum(LINE_FIELDS), z.string().nullable()),
      }),
    )
    .optional(),
});

recordsRouter.patch('/:id/fields', async (req, res, next) => {
  try {
    const updates = fieldUpdateSchema.parse(req.body);
    await records.updateFields(actorOf(req), req.params.id!, updates);
    res.json(await detailResponse(req.params.id!));
  } catch (err) {
    next(err);
  }
});

recordsRouter.post('/:id/lines', async (req, res, next) => {
  try {
    await records.addLine(actorOf(req), req.params.id!);
    res.json(await detailResponse(req.params.id!));
  } catch (err) {
    next(err);
  }
});

recordsRouter.delete('/:id/lines/:lineNumber', async (req, res, next) => {
  try {
    const { lineNumber } = lineParamsSchema.parse(req.params);
    await records.deleteLine(actorOf(req), req.params.id!, lineNumber);
    res.json(await detailResponse(req.params.id!));
  } catch (err) {
    next(err);
  }
});

recordsRouter.post('/:id/acknowledge', async (req, res, next) => {
  try {
    // One warning ({ code, fieldPath }), or every warning currently raised ({ all: true }).
    const body = z
      .union([
        z.object({ all: z.literal(true) }),
        z.object({ code: z.string().min(1), fieldPath: z.string().min(1) }),
      ])
      .parse(req.body);
    await records.acknowledgeWarnings(actorOf(req), req.params.id!, 'all' in body ? 'all' : body);
    res.json(await detailResponse(req.params.id!));
  } catch (err) {
    next(err);
  }
});

// ---- FR-7 approval, FR-11 recovery ---------------------------------------

recordsRouter.post('/:id/approve', async (req, res, next) => {
  try {
    await records.approveRecord(actorOf(req), req.params.id!);
    res.json(await detailResponse(req.params.id!));
  } catch (err) {
    next(err);
  }
});

recordsRouter.post('/:id/reject', async (req, res, next) => {
  try {
    const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
    await records.rejectRecord(actorOf(req), req.params.id!, reason);
    res.json(await detailResponse(req.params.id!));
  } catch (err) {
    next(err);
  }
});

recordsRouter.post('/:id/resubmit', async (req, res, next) => {
  try {
    await records.resubmitRecord(actorOf(req), req.params.id!);
    res.json(await detailResponse(req.params.id!));
  } catch (err) {
    next(err);
  }
});

recordsRouter.post('/:id/retry-extraction', async (req, res, next) => {
  try {
    await records.retryExtraction(actorOf(req), req.params.id!);
    res.json(await detailResponse(req.params.id!));
  } catch (err) {
    next(err);
  }
});

recordsRouter.post('/:id/manual-entry', async (req, res, next) => {
  try {
    await records.switchToManualEntry(actorOf(req), req.params.id!);
    res.json(await detailResponse(req.params.id!));
  } catch (err) {
    next(err);
  }
});
