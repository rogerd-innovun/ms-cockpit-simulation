import type { POStatus, Prisma, Role, User } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { assertTransition, isEditable } from '../domain/status.js';
import {
  HEADER_FIELDS,
  LINE_FIELDS,
  headerFieldPath,
  lineFieldPath,
  type HeaderField,
  type LineField,
} from '../domain/types.js';
import { blockingIssues, validateRecord, type ValidationIssue } from '../domain/validation.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { correlationIdFor, newRecordId } from '../lib/ids.js';
import { childLogger } from '../lib/logger.js';
import { writeAudit } from './audit.js';
import { mapSapError } from './sap/errorMap.js';
import { submitToSap } from './sap/outbound.js';
import { deleteDocument, looksLikePdf, storeDocument } from './storage.js';

const log = childLogger('records');

export interface Actor {
  id: string;
  role: Role;
  name: string;
}

const canApprove = (role: Role) => role === 'APPROVER' || role === 'ADMIN';

// ---------------------------------------------------------------- FR-1 upload

export async function createRecord(
  actor: Actor,
  file: { buffer: Buffer; originalname: string; mimetype: string },
  meta: { vendorHint?: string; notes?: string } = {},
) {
  // FR-1.2 / NFR-3.4 — validate by content, not by the filename extension.
  if (!looksLikePdf(file.buffer)) {
    throw badRequest(
      'Only PDF files are accepted. This file does not start with a PDF signature.',
      'NOT_A_PDF',
    );
  }
  if (file.buffer.byteLength > env.MAX_UPLOAD_BYTES) {
    throw badRequest(
      `File is ${(file.buffer.byteLength / 1024 / 1024).toFixed(1)} MB; the limit is ${(
        env.MAX_UPLOAD_BYTES /
        1024 /
        1024
      ).toFixed(0)} MB.`,
      'FILE_TOO_LARGE',
    );
  }

  // FR-8.1 — allocate the id first so the correlation ID derives from it.
  const recordId = newRecordId();
  const correlationId = correlationIdFor(recordId);
  const stored = await storeDocument(recordId, file.buffer);

  try {
    const record = await prisma.pORecord.create({
      data: {
        id: recordId,
        correlationId,
        status: 'DRAFT',
        uploadedById: actor.id,
        vendorHint: meta.vendorHint?.trim() || null,
        notes: meta.notes?.trim() || null,
        sourceDocument: {
          create: {
            originalFilename: file.originalname,
            storagePath: stored.storagePath,
            mimeType: 'application/pdf',
            byteSize: stored.byteSize,
            contentHash: stored.contentHash,
            // The durable copy — the file at storagePath is only a cache on hosts
            // with ephemeral disks (FR-1.9: the PDF stays viewable at every stage).
            // Copied into a plain Uint8Array because Prisma's Bytes type does not
            // accept a Node Buffer's ArrayBufferLike backing.
            content: new Uint8Array(file.buffer),
            pageCount: stored.pageCount,
          },
        },
      },
      include: { sourceDocument: true },
    });

    await writeAudit({
      recordId,
      eventType: 'RECORD_UPLOADED',
      message: `Uploaded ${file.originalname} (${stored.byteSize} bytes, ${stored.pageCount ?? '?'} page(s))`,
      actorId: actor.id,
    });

    return { record, duplicates: await findDuplicates(stored.contentHash, recordId) };
  } catch (err) {
    // FR-1.8 — no orphaned file when the record cannot be created.
    await deleteDocument(recordId);
    throw err;
  }
}

/** FR-3.4 — same bytes as an existing live record. */
export async function findDuplicates(contentHash: string, excludeRecordId: string) {
  const docs = await prisma.sourceDocument.findMany({
    where: {
      contentHash,
      recordId: { not: excludeRecordId },
      record: { deletedAt: null, status: { not: 'CANCELLED' } },
    },
    include: { record: { select: { id: true, correlationId: true, status: true } } },
  });
  return docs.map((d) => ({
    recordId: d.record.id,
    correlationId: d.record.correlationId,
    status: d.record.status,
    originalFilename: d.originalFilename,
    matchedOn: 'FILE_HASH' as const,
  }));
}

/** FR-3.5 — same PO number and customer as an existing live record. */
export async function findPoNumberDuplicates(recordId: string) {
  const header = await prisma.pOHeader.findUnique({ where: { recordId } });
  if (!header?.poNumber || !header.customerCode) return [];
  const matches = await prisma.pOHeader.findMany({
    where: {
      poNumber: header.poNumber,
      customerCode: header.customerCode,
      recordId: { not: recordId },
      record: { deletedAt: null, status: { not: 'CANCELLED' } },
    },
    include: { record: { select: { id: true, correlationId: true, status: true } } },
  });
  return matches.map((m) => ({
    recordId: m.record.id,
    correlationId: m.record.correlationId,
    status: m.record.status,
    poNumber: m.poNumber,
    matchedOn: 'PO_NUMBER_AND_CUSTOMER' as const,
  }));
}

// -------------------------------------------------------------- FR-3 publish

export async function publishRecord(actor: Actor, recordId: string, overrideReason?: string) {
  const record = await getRecordOrThrow(recordId);

  // FR-3.3 — idempotent: publishing twice must not enqueue two extractions.
  if (record.status === 'PUBLISHED' || record.status === 'PROCESSING') {
    return record;
  }
  assertTransition(record.status, 'PUBLISHED');

  const duplicates = await findDuplicates(record.sourceDocument!.contentHash, recordId);
  if (duplicates.length > 0) {
    const submitted = duplicates.filter((d) =>
      (['SENT_TO_SAP', 'SO_CREATED'] as POStatus[]).includes(d.status),
    );
    // FR-3.4 — block only where a duplicate already reached SAP; otherwise warn and
    // require the user to say why they are proceeding.
    if ((env.DUPLICATE_POLICY === 'block' || submitted.length > 0) && !overrideReason) {
      throw conflict(
        `This PDF is identical to ${duplicates.length} existing record(s)${
          submitted.length > 0 ? ', one of which has already been sent to SAP' : ''
        }. Provide an override reason to publish it anyway.`,
        'DUPLICATE_DOCUMENT',
        { duplicates },
      );
    }
  }

  const updated = await prisma.pORecord.update({
    where: { id: recordId },
    data: { status: 'PUBLISHED', statusChangedAt: new Date() },
    include: recordInclude,
  });

  await writeAudit({
    recordId,
    eventType: 'RECORD_PUBLISHED',
    message: overrideReason
      ? `Published despite a duplicate warning. Reason: ${overrideReason}`
      : 'Published for extraction',
    actorId: actor.id,
  });
  await writeAudit({
    recordId,
    eventType: 'STATUS_CHANGED',
    message: `${record.status} → PUBLISHED`,
    actorId: actor.id,
  });

  return updated;
}

// ------------------------------------------------------- FR-7 review editing

export interface FieldUpdates {
  header?: Partial<Record<HeaderField, string | null>>;
  lines?: {
    lineNumber: number;
    values: Partial<Record<LineField, string | null>>;
  }[];
}

export async function updateFields(actor: Actor, recordId: string, updates: FieldUpdates) {
  const record = await getRecordOrThrow(recordId);
  // INV-05
  if (!isEditable(record.status)) {
    throw conflict(
      `Extracted values cannot be edited while the record is ${record.status}.`,
      'NOT_EDITABLE',
    );
  }

  const header =
    record.header ??
    (await prisma.pOHeader.create({ data: { recordId }, include: { lineItems: true } }));

  const auditEntries: { fieldPath: string; before: string | null; after: string | null }[] = [];

  if (updates.header) {
    const data: Record<string, string | null> = {};
    for (const field of HEADER_FIELDS) {
      if (!(field in updates.header)) continue;
      const next = normalise(updates.header[field]);
      const prev = (header as Record<string, unknown>)[field] as string | null;
      if (next === prev) continue;
      data[field] = next;
      auditEntries.push({ fieldPath: headerFieldPath(field), before: prev, after: next });
    }
    if (Object.keys(data).length > 0) {
      await prisma.pOHeader.update({ where: { id: header.id }, data });
    }
  }

  for (const lineUpdate of updates.lines ?? []) {
    const existing = await prisma.pOLineItem.findUnique({
      where: { headerId_lineNumber: { headerId: header.id, lineNumber: lineUpdate.lineNumber } },
    });
    if (!existing) {
      throw badRequest(`Line ${lineUpdate.lineNumber} does not exist on this record.`, 'NO_SUCH_LINE');
    }
    const data: Record<string, string | null> = {};
    for (const field of LINE_FIELDS) {
      if (!(field in lineUpdate.values)) continue;
      const next = normalise(lineUpdate.values[field]);
      const prev = (existing as Record<string, unknown>)[field] as string | null;
      if (next === prev) continue;
      data[field] = next;
      auditEntries.push({
        fieldPath: lineFieldPath(lineUpdate.lineNumber, field),
        before: prev,
        after: next,
      });
    }
    if (Object.keys(data).length > 0) {
      await prisma.pOLineItem.update({ where: { id: existing.id }, data });
    }
  }

  // FR-5.4 / FR-7.6 — record who changed what; the extracted value is never overwritten.
  for (const entry of auditEntries) {
    await prisma.fieldExtraction.upsert({
      where: { recordId_fieldPath: { recordId, fieldPath: entry.fieldPath } },
      create: {
        recordId,
        fieldPath: entry.fieldPath,
        extractedValue: entry.before,
        confidence: null,
        editedById: actor.id,
        editedAt: new Date(),
      },
      update: { editedById: actor.id, editedAt: new Date() },
    });
    await writeAudit({
      recordId,
      eventType: 'FIELD_EDITED',
      message: `${entry.fieldPath}: "${entry.before ?? ''}" → "${entry.after ?? ''}"`,
      before: { value: entry.before } as Prisma.InputJsonValue,
      after: { value: entry.after } as Prisma.InputJsonValue,
      actorId: actor.id,
    });
  }

  return getRecordDetail(recordId);
}

/** FR-7.5 — lines can be added and removed during review. */
export async function addLine(actor: Actor, recordId: string) {
  const record = await getRecordOrThrow(recordId);
  if (!isEditable(record.status)) {
    throw conflict(`Lines cannot be added while the record is ${record.status}.`, 'NOT_EDITABLE');
  }
  const header =
    record.header ?? (await prisma.pOHeader.create({ data: { recordId }, include: { lineItems: true } }));
  const max = await prisma.pOLineItem.aggregate({
    where: { headerId: header.id },
    _max: { lineNumber: true },
  });
  const lineNumber = (max._max.lineNumber ?? 0) + 1;
  await prisma.pOLineItem.create({ data: { headerId: header.id, lineNumber } });
  await writeAudit({
    recordId,
    eventType: 'LINE_ADDED',
    message: `Added line ${lineNumber}`,
    actorId: actor.id,
  });
  return getRecordDetail(recordId);
}

export async function deleteLine(actor: Actor, recordId: string, lineNumber: number) {
  const record = await getRecordOrThrow(recordId);
  if (!isEditable(record.status)) {
    throw conflict(`Lines cannot be removed while the record is ${record.status}.`, 'NOT_EDITABLE');
  }
  if (!record.header) throw notFound('This record has no extracted data yet.');
  const line = await prisma.pOLineItem.findUnique({
    where: { headerId_lineNumber: { headerId: record.header.id, lineNumber } },
  });
  if (!line) throw notFound(`Line ${lineNumber} does not exist.`);
  await prisma.pOLineItem.delete({ where: { id: line.id } });
  await writeAudit({
    recordId,
    eventType: 'LINE_DELETED',
    message: `Deleted line ${lineNumber} (material ${line.materialCode ?? 'blank'})`,
    before: { lineNumber, materialCode: line.materialCode } as Prisma.InputJsonValue,
    actorId: actor.id,
  });
  return getRecordDetail(recordId);
}

/** FR-6.9 */
export async function acknowledgeWarning(
  actor: Actor,
  recordId: string,
  code: string,
  fieldPath: string,
) {
  await prisma.validationAck.upsert({
    where: { recordId_code_fieldPath: { recordId, code, fieldPath } },
    create: { recordId, code, fieldPath, acknowledgedById: actor.id },
    update: { acknowledgedById: actor.id, acknowledgedAt: new Date() },
  });
  await writeAudit({
    recordId,
    eventType: 'WARNING_ACKNOWLEDGED',
    message: `Accepted warning ${code} on ${fieldPath}`,
    actorId: actor.id,
  });
  return getRecordDetail(recordId);
}

// ------------------------------------------------------------ FR-7 approval

export async function approveRecord(actor: Actor, recordId: string) {
  const record = await getRecordOrThrow(recordId);

  // FR-7.14
  assertTransition(record.status, 'APPROVED');

  if (!canApprove(actor.role)) {
    throw forbidden('Your role cannot approve records.', 'NOT_AN_APPROVER');
  }

  // FR-7.11 (OQ-01) — segregation of duties.
  if (env.SOD_REQUIRE_SEPARATE_APPROVER && record.uploadedById === actor.id) {
    throw forbidden(
      'This record must be approved by someone other than the person who uploaded it.',
      'SOD_VIOLATION',
    );
  }

  // FR-6.8 — re-validate server-side at the moment of approval, never trust the client.
  const issues = await validateRecord(record.header);
  const blocking = blockingIssues(issues);
  if (blocking.length > 0) {
    throw badRequest(
      `Cannot approve: ${blocking.length} blocking validation issue(s) remain.`,
      'VALIDATION_BLOCKED',
      { issues: blocking },
    );
  }

  const attempt = record.currentAttempt + 1;
  // FR-7.10 / DM-03 — snapshot exactly what was approved, immutably.
  const snapshot = {
    header: Object.fromEntries(
      HEADER_FIELDS.map((f) => [f, (record.header as Record<string, unknown>)[f] ?? null]),
    ),
    lineItems: [...(record.header?.lineItems ?? [])]
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((l) => ({
        lineNumber: l.lineNumber,
        ...Object.fromEntries(LINE_FIELDS.map((f) => [f, (l as Record<string, unknown>)[f] ?? null])),
      })),
    approvedAt: new Date().toISOString(),
    approvedBy: { id: actor.id, name: actor.name },
  };

  await prisma.$transaction(async (tx) => {
    await tx.submission.create({
      data: {
        recordId,
        attempt,
        approvedById: actor.id,
        approvedSnapshot: snapshot as Prisma.InputJsonValue,
      },
    });
    await tx.pORecord.update({
      where: { id: recordId },
      data: {
        status: 'APPROVED',
        currentAttempt: attempt,
        statusChangedAt: new Date(),
        failureCode: null,
        failureMessage: null,
      },
    });
  });

  await writeAudit({
    recordId,
    eventType: 'APPROVED',
    message: `Approved attempt ${attempt} with ${snapshot.lineItems.length} line item(s)`,
    after: snapshot as Prisma.InputJsonValue,
    actorId: actor.id,
  });
  await writeAudit({
    recordId,
    eventType: 'STATUS_CHANGED',
    message: `${record.status} → APPROVED`,
    actorId: actor.id,
  });

  // FR-9.1 — the handoff runs after approval commits, so a slow or failing filesystem
  // cannot roll back the approval the user just made.
  void submitToSap(recordId).catch((err) =>
    log.error({ recordId, err: (err as Error).message }, 'submitToSap threw'),
  );

  return getRecordDetail(recordId);
}

/** FR-7.12 */
export async function rejectRecord(actor: Actor, recordId: string, reason: string) {
  if (!reason?.trim()) throw badRequest('A rejection reason is required.', 'REASON_REQUIRED');
  const record = await getRecordOrThrow(recordId);
  if (record.status !== 'NEEDS_REVIEW') {
    throw conflict(`Only a record in NEEDS_REVIEW can be rejected (this one is ${record.status}).`);
  }
  await writeAudit({
    recordId,
    eventType: 'APPROVAL_REJECTED',
    message: reason.trim(),
    actorId: actor.id,
  });
  await prisma.pORecord.update({
    where: { id: recordId },
    data: { notes: reason.trim(), statusChangedAt: new Date() },
  });
  return getRecordDetail(recordId);
}

/** FR-11.4 — a failed record goes back for correction, keeping everything it had. */
export async function resubmitRecord(actor: Actor, recordId: string) {
  const record = await getRecordOrThrow(recordId);
  assertTransition(record.status, 'NEEDS_REVIEW');
  await prisma.pORecord.update({
    where: { id: recordId },
    data: { status: 'NEEDS_REVIEW', statusChangedAt: new Date() },
  });
  await writeAudit({
    recordId,
    eventType: 'RESUBMITTED',
    message: `Returned to review after failure: ${record.failureCode ?? 'unknown'}`,
    actorId: actor.id,
  });
  await writeAudit({
    recordId,
    eventType: 'STATUS_CHANGED',
    message: `${record.status} → NEEDS_REVIEW`,
    actorId: actor.id,
  });
  return getRecordDetail(recordId);
}

/** FR-4.12 follow-up — retry a failed extraction. */
export async function retryExtraction(actor: Actor, recordId: string) {
  const record = await getRecordOrThrow(recordId);
  if (record.status !== 'EXTRACTION_FAILED') {
    throw conflict(`Only an EXTRACTION_FAILED record can be retried (this one is ${record.status}).`);
  }
  await prisma.pORecord.update({
    where: { id: recordId },
    data: { status: 'PUBLISHED', statusChangedAt: new Date() },
  });
  await writeAudit({
    recordId,
    eventType: 'EXTRACTION_RETRIED',
    message: 'Extraction retry requested',
    actorId: actor.id,
  });
  return getRecordDetail(recordId);
}

/** FR-5.7 — abandon extraction and key the data in by hand. */
export async function switchToManualEntry(actor: Actor, recordId: string) {
  const record = await getRecordOrThrow(recordId);
  assertTransition(record.status, 'NEEDS_REVIEW');
  await prisma.$transaction(async (tx) => {
    const header =
      (await tx.pOHeader.findUnique({ where: { recordId } })) ??
      (await tx.pOHeader.create({ data: { recordId } }));
    const lineCount = await tx.pOLineItem.count({ where: { headerId: header.id } });
    if (lineCount === 0) {
      await tx.pOLineItem.create({ data: { headerId: header.id, lineNumber: 1 } });
    }
    await tx.pORecord.update({
      where: { id: recordId },
      data: { status: 'NEEDS_REVIEW', statusChangedAt: new Date() },
    });
  });
  await writeAudit({
    recordId,
    eventType: 'STATUS_CHANGED',
    message: 'EXTRACTION_FAILED → NEEDS_REVIEW (manual entry)',
    actorId: actor.id,
  });
  return getRecordDetail(recordId);
}

export async function cancelRecord(actor: Actor, recordId: string, reason?: string) {
  const record = await getRecordOrThrow(recordId);
  assertTransition(record.status, 'CANCELLED');
  await prisma.pORecord.update({
    where: { id: recordId },
    data: { status: 'CANCELLED', statusChangedAt: new Date() },
  });
  await writeAudit({
    recordId,
    eventType: 'RECORD_CANCELLED',
    message: reason?.trim() || 'Cancelled by user',
    actorId: actor.id,
  });
  return getRecordDetail(recordId);
}

/** FR-2.3 — soft delete; the audit trail survives (DM-04). */
export async function deleteDraft(actor: Actor, recordId: string) {
  const record = await getRecordOrThrow(recordId);
  if (record.status !== 'DRAFT') {
    throw conflict(`Only a DRAFT record can be deleted (this one is ${record.status}).`);
  }
  await prisma.pORecord.update({ where: { id: recordId }, data: { deletedAt: new Date() } });
  await writeAudit({
    recordId,
    eventType: 'RECORD_DELETED',
    message: 'Draft deleted',
    actorId: actor.id,
  });
}

// ------------------------------------------------------------------ queries

const recordInclude = {
  sourceDocument: true,
  header: { include: { lineItems: { orderBy: { lineNumber: 'asc' } } } },
  uploadedBy: { select: { id: true, name: true, email: true } },
  vendorProfile: { select: { id: true, name: true, version: true } },
} satisfies Prisma.PORecordInclude;

export async function getRecordOrThrow(recordId: string) {
  const record = await prisma.pORecord.findFirst({
    where: { id: recordId, deletedAt: null },
    include: recordInclude,
  });
  if (!record) throw notFound('PO record not found.');
  return record;
}

/** FR-12.5 — everything the detail view and the review screen need, in one shape. */
export async function getRecordDetail(recordId: string) {
  const record = await getRecordOrThrow(recordId);

  const [fields, submissions, results, audit, acks, lastRun] = await Promise.all([
    prisma.fieldExtraction.findMany({
      where: { recordId },
      include: { editedBy: { select: { id: true, name: true } } },
    }),
    prisma.submission.findMany({
      where: { recordId },
      orderBy: { attempt: 'asc' },
      include: { approvedBy: { select: { id: true, name: true } } },
    }),
    prisma.sapResult.findMany({ where: { recordId }, orderBy: { ingestedAt: 'asc' } }),
    prisma.auditEvent.findMany({
      where: { recordId },
      orderBy: { timestamp: 'asc' },
      include: { actor: { select: { id: true, name: true } } },
    }),
    prisma.validationAck.findMany({ where: { recordId } }),
    prisma.extractionRun.findFirst({
      where: { recordId, outcome: 'SUCCESS' },
      orderBy: { attempt: 'desc' },
      select: { provider: true, model: true, latencyMs: true, attempt: true },
    }),
  ]);

  const issues = await validateRecord(record.header);
  const acknowledged = new Set(acks.map((a) => `${a.code}::${a.fieldPath}`));

  /**
   * FR-7.2 / NFR-5.2 — the read, summarised so a reviewer can see at a glance how
   * much to trust it. Confidence is the model's own certainty, not measured
   * accuracy; `corrected` is the measured part — what humans actually changed.
   * Null when nothing was extracted (drafts, manual entry before any run).
   */
  const confidences = fields
    .map((f) => f.confidence)
    .filter((c): c is number => c != null);
  const extractionQuality =
    confidences.length === 0
      ? null
      : {
          fieldsTotal: fields.length,
          fieldsRead: fields.filter((f) => f.extractedValue != null).length,
          avgConfidence: confidences.reduce((a, b) => a + b, 0) / confidences.length,
          minConfidence: Math.min(...confidences),
          belowThreshold: confidences.filter((c) => c < env.CONFIDENCE_THRESHOLD).length,
          corrected: fields.filter((f) => f.editedAt != null).length,
          provider: lastRun?.provider ?? null,
          model: lastRun?.model ?? null,
          latencyMs: lastRun?.latencyMs ?? null,
          attempts: lastRun?.attempt ?? null,
        };

  return {
    extractionQuality,
    record,
    fields: fields.map((f) => ({
      fieldPath: f.fieldPath,
      extractedValue: f.extractedValue,
      confidence: f.confidence,
      // FR-5.5
      lowConfidence: f.confidence != null && f.confidence < env.CONFIDENCE_THRESHOLD,
      editedBy: f.editedBy,
      editedAt: f.editedAt,
    })),
    validation: {
      threshold: env.CONFIDENCE_THRESHOLD,
      issues: issues.map((i) => ({
        ...i,
        acknowledged: acknowledged.has(`${i.code}::${i.fieldPath}`),
      })) as (ValidationIssue & { acknowledged: boolean })[],
      blockingCount: blockingIssues(issues).length,
    },
    submissions,
    results,
    audit,
    failure: mapSapError(record.failureCode, record.failureMessage),
    permissions: null as null | Record<string, boolean>,
  };
}

export interface ListFilters {
  status?: POStatus[];
  q?: string;
  uploadedById?: string;
  take?: number;
  skip?: number;
}

/** FR-12.1 to FR-12.3 */
export async function listRecords(filters: ListFilters) {
  const where: Prisma.PORecordWhereInput = { deletedAt: null };
  if (filters.status?.length) where.status = { in: filters.status };
  if (filters.uploadedById) where.uploadedById = filters.uploadedById;
  if (filters.q?.trim()) {
    const q = filters.q.trim();
    where.OR = [
      { correlationId: { contains: q, mode: 'insensitive' } },
      { soNumber: { contains: q, mode: 'insensitive' } },
      { header: { poNumber: { contains: q, mode: 'insensitive' } } },
      { header: { customerName: { contains: q, mode: 'insensitive' } } },
      { header: { customerCode: { contains: q, mode: 'insensitive' } } },
      { sourceDocument: { originalFilename: { contains: q, mode: 'insensitive' } } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.pORecord.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(filters.take ?? 50, 200),
      skip: filters.skip ?? 0,
      include: {
        sourceDocument: { select: { originalFilename: true, pageCount: true } },
        header: {
          select: {
            poNumber: true,
            customerName: true,
            customerCode: true,
            poTotalValue: true,
            currency: true,
            _count: { select: { lineItems: true } },
          },
        },
        uploadedBy: { select: { id: true, name: true } },
      },
    }),
    prisma.pORecord.count({ where }),
  ]);

  return { rows, total };
}

/** Counts for the worklist tabs. FR-12.4 */
export async function statusCounts() {
  const grouped = await prisma.pORecord.groupBy({
    by: ['status'],
    where: { deletedAt: null },
    _count: true,
  });
  return Object.fromEntries(grouped.map((g) => [g.status, g._count]));
}

const normalise = (v: string | null | undefined): string | null => {
  if (v == null) return null;
  const t = v.trim();
  return t === '' ? null : t;
};

export type { User };
