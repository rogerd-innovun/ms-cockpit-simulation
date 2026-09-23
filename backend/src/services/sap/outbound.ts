import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import { sha256 } from '../../lib/ids.js';
import { childLogger } from '../../lib/logger.js';
import { writeAudit } from '../audit.js';
import { buildOutboundPayload, outboundBaseName } from './csv.js';
import type { HeaderWithLines } from '../../domain/validation.js';

const log = childLogger('sap-outbound');

/**
 * FR-9.6 to FR-9.8 — the SAP job must never read a half-written file.
 *
 * Two conventions, both implemented, selected by COMPLETENESS_CONVENTION (OQ-04):
 *   rename       — write into .staging on the same filesystem, fsync, then rename in.
 *                  The rename is atomic, so the file appears complete or not at all.
 *   done_marker  — write the data file, fsync, then write a zero-byte .done sentinel.
 *                  Used when the SAP job watches for the marker rather than the data file.
 *
 * IC-11 — staging shares a filesystem with outbound, or the rename is a copy and the
 * atomicity guarantee is lost.
 */
async function writeFileDurably(target: string, content: string): Promise<void> {
  const handle = await fs.open(target, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    // FR-9.8 — force to disk before anything downstream is told the file exists.
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface WriteResult {
  filenames: string[];
  paths: string[];
  byteSize: number;
  checksum: string;
}

export async function writeOutboundFiles(
  correlationId: string,
  attempt: number,
  header: HeaderWithLines,
): Promise<WriteResult> {
  const payload = buildOutboundPayload(correlationId, attempt, header);
  const base = outboundBaseName(correlationId, attempt);

  await fs.mkdir(env.paths.staging, { recursive: true });
  await fs.mkdir(env.paths.outbound, { recursive: true });

  const filenames: string[] = [];
  const paths: string[] = [];
  let byteSize = 0;
  const combined: string[] = [];

  try {
    for (const file of payload.files) {
      const filename = `${base}${file.suffix}`;
      const finalPath = path.join(env.paths.outbound, filename);

      if (env.COMPLETENESS_CONVENTION === 'rename') {
        const stagedPath = path.join(env.paths.staging, filename);
        await writeFileDurably(stagedPath, file.content);
        await fs.rename(stagedPath, finalPath);
      } else {
        await writeFileDurably(finalPath, file.content);
      }

      filenames.push(filename);
      paths.push(finalPath);
      byteSize += Buffer.byteLength(file.content, 'utf8');
      combined.push(file.content);
    }

    if (env.COMPLETENESS_CONVENTION === 'done_marker') {
      // Written last, after every data file is durable — it is the signal to proceed.
      const markerPath = path.join(env.paths.outbound, `${base}.done`);
      await writeFileDurably(markerPath, '');
      filenames.push(`${base}.done`);
    }
  } catch (err) {
    // FR-9.10 — leave no partial artefacts behind for the SAP job to trip over.
    await Promise.allSettled([
      ...paths.map((p) => fs.rm(p, { force: true })),
      ...payload.files.map((f) =>
        fs.rm(path.join(env.paths.staging, `${base}${f.suffix}`), { force: true }),
      ),
    ]);
    throw err;
  }

  return { filenames, paths, byteSize, checksum: sha256(combined.join('\n')) };
}

/**
 * FR-9.9 — hand the approved record to SAP and move it to SENT_TO_SAP.
 * FR-9.11 — one file set per (correlationId, attempt); the Submission row's unique
 * constraint is what actually enforces that, not this function's control flow.
 */
export async function submitToSap(recordId: string): Promise<void> {
  const record = await prisma.pORecord.findUnique({
    where: { id: recordId },
    include: { header: { include: { lineItems: true } } },
  });
  if (!record) return;
  if (record.status !== 'APPROVED') {
    log.warn({ recordId, status: record.status }, 'submitToSap called on a non-APPROVED record');
    return;
  }
  if (!record.header) {
    log.error({ recordId }, 'approved record has no header; cannot build outbound file');
    return;
  }

  const submission = await prisma.submission.findUnique({
    where: { recordId_attempt: { recordId, attempt: record.currentAttempt } },
  });
  if (!submission) {
    log.error({ recordId }, 'no submission row for the current attempt');
    return;
  }
  if (submission.writtenAt) {
    log.info({ recordId }, 'outbound file already written for this attempt; skipping');
    return;
  }

  try {
    const written = await writeOutboundFiles(
      record.correlationId,
      record.currentAttempt,
      record.header,
    );

    await prisma.$transaction(async (tx) => {
      await tx.submission.update({
        where: { id: submission.id },
        data: {
          outboundFilename: written.filenames.join(', '),
          outboundPath: written.paths[0] ?? null,
          byteSize: written.byteSize,
          checksum: written.checksum,
          writtenAt: new Date(),
          writeError: null,
        },
      });
      await tx.pORecord.update({
        where: { id: recordId },
        data: { status: 'SENT_TO_SAP', statusChangedAt: new Date(), sentToSapAt: new Date() },
      });
    });

    await writeAudit({
      recordId,
      eventType: 'OUTBOUND_WRITTEN',
      message: `Wrote ${written.filenames.join(', ')} (${written.byteSize} bytes) to the SAP drop folder`,
      after: { filenames: written.filenames, checksum: written.checksum },
      actorName: 'sap-outbound',
    });
    await writeAudit({
      recordId,
      eventType: 'STATUS_CHANGED',
      message: 'APPROVED → SENT_TO_SAP',
      actorName: 'sap-outbound',
    });
    log.info({ recordId, files: written.filenames }, 'submitted to SAP');
  } catch (err) {
    const message = (err as Error).message;
    // FR-9.10 — return to review rather than stranding the record in APPROVED.
    await prisma.$transaction(async (tx) => {
      await tx.submission.update({
        where: { id: submission.id },
        data: { writeError: message },
      });
      await tx.pORecord.update({
        where: { id: recordId },
        data: {
          status: 'NEEDS_REVIEW',
          statusChangedAt: new Date(),
          failureCode: 'OUTBOUND_WRITE_FAILED',
          failureMessage: message,
        },
      });
    });
    await writeAudit({
      recordId,
      eventType: 'OUTBOUND_WRITE_FAILED',
      message,
      actorName: 'sap-outbound',
    });
    await writeAudit({
      recordId,
      eventType: 'STATUS_CHANGED',
      message: 'APPROVED → NEEDS_REVIEW (outbound write failed)',
      actorName: 'sap-outbound',
    });
    log.error({ recordId, message }, 'outbound write failed');
  }
}

/** FR-9.12 — surface a drop folder that cannot be written to before records pile up. */
export async function checkOutboundWritable(): Promise<{ ok: boolean; error?: string }> {
  const probe = path.join(env.paths.outbound, `.healthcheck-${process.pid}`);
  try {
    await fs.mkdir(env.paths.outbound, { recursive: true });
    await fs.writeFile(probe, '');
    await fs.rm(probe, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
