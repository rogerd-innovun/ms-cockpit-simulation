import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import { childLogger } from '../../lib/logger.js';
import { writeAudit } from '../audit.js';
import { ResultParseError, parseResultFile, type ParsedResult } from './resultParser.js';

const log = childLogger('sap-result-watcher');

const DATA_EXTENSIONS = ['.csv', '.json'];

/** FR-10.2 — only consume a file once it is confirmed complete. */
async function isComplete(dir: string, filename: string): Promise<boolean> {
  if (env.COMPLETENESS_CONVENTION === 'done_marker') {
    const base = filename.replace(/\.[^.]+$/, '');
    try {
      await fs.access(path.join(dir, `${base}.done`));
      return true;
    } catch {
      return false;
    }
  }
  // With the rename convention the file is atomically complete on appearance. The
  // stable-size check is a cheap belt-and-braces against a writer that does neither.
  const first = await fs.stat(path.join(dir, filename));
  await new Promise((r) => setTimeout(r, 250));
  const second = await fs.stat(path.join(dir, filename));
  return first.size === second.size && first.size > 0;
}

async function moveTo(destDir: string, sourcePath: string, filename: string): Promise<void> {
  const dated = path.join(destDir, new Date().toISOString().slice(0, 10));
  await fs.mkdir(dated, { recursive: true });
  await fs.rename(sourcePath, path.join(dated, filename));
}

/** Removes the marker that accompanied a consumed data file, if the convention uses one. */
async function removeMarker(dir: string, filename: string): Promise<void> {
  if (env.COMPLETENESS_CONVENTION !== 'done_marker') return;
  const base = filename.replace(/\.[^.]+$/, '');
  await fs.rm(path.join(dir, `${base}.done`), { force: true });
}

async function quarantine(
  filename: string,
  sourcePath: string,
  content: string,
  reason: string,
  correlationId: string,
): Promise<void> {
  // FR-10.6 / FR-10.7 — quarantined, never deleted.
  await prisma.sapResult.create({
    data: {
      correlationId,
      outcome: 'ERROR',
      rawContent: content,
      sourceFilename: filename,
      quarantined: true,
      quarantineReason: reason,
      errorMessage: reason,
    },
  });
  await removeMarker(path.dirname(sourcePath), filename);
  await moveTo(env.paths.quarantine, sourcePath, filename);
  await writeAudit({
    eventType: 'RESULT_QUARANTINED',
    message: `${filename}: ${reason}`,
    actorName: 'sap-result-watcher',
  });
  log.error({ filename, reason }, 'result file quarantined — needs operations attention');
}

async function applyResult(
  filename: string,
  sourcePath: string,
  content: string,
  parsed: ParsedResult,
): Promise<void> {
  const record = await prisma.pORecord.findUnique({
    where: { correlationId: parsed.correlationId },
  });

  // FR-10.6 — a result we cannot match to a record is an operations problem, not a no-op.
  if (!record) {
    await quarantine(
      filename,
      sourcePath,
      content,
      `No PO record matches correlation ID ${parsed.correlationId}.`,
      parsed.correlationId,
    );
    return;
  }

  // FR-10.8 — a result for a superseded attempt must never move the record.
  if (parsed.attempt != null && parsed.attempt !== record.currentAttempt) {
    await prisma.sapResult.create({
      data: {
        recordId: record.id,
        correlationId: parsed.correlationId,
        attempt: parsed.attempt,
        outcome: parsed.outcome,
        soNumber: parsed.soNumber,
        errorCode: parsed.errorCode,
        errorMessage: parsed.errorMessage,
        sapTimestamp: parsed.sapTimestamp,
        rawContent: content,
        sourceFilename: filename,
      },
    });
    await writeAudit({
      recordId: record.id,
      eventType: 'RESULT_STALE_IGNORED',
      message: `Ignored result for attempt ${parsed.attempt}; the record is on attempt ${record.currentAttempt}.`,
      actorName: 'sap-result-watcher',
    });
    await removeMarker(path.dirname(sourcePath), filename);
    await moveTo(env.paths.archive, sourcePath, filename);
    log.warn({ filename, recordId: record.id }, 'stale result ignored');
    return;
  }

  if (record.status !== 'SENT_TO_SAP') {
    await writeAudit({
      recordId: record.id,
      eventType: 'RESULT_STALE_IGNORED',
      message: `Result arrived while the record was in ${record.status}; no status change applied.`,
      actorName: 'sap-result-watcher',
    });
    await removeMarker(path.dirname(sourcePath), filename);
    await moveTo(env.paths.archive, sourcePath, filename);
    return;
  }

  const success = parsed.outcome === 'SUCCESS';

  // FR-10.9 — the unique constraint on sourceFilename makes reprocessing the same file
  // a no-op rather than a duplicate status change.
  await prisma.$transaction(async (tx) => {
    await tx.sapResult.create({
      data: {
        recordId: record.id,
        correlationId: parsed.correlationId,
        attempt: parsed.attempt ?? record.currentAttempt,
        outcome: parsed.outcome,
        soNumber: parsed.soNumber,
        errorCode: parsed.errorCode,
        errorMessage: parsed.errorMessage,
        sapTimestamp: parsed.sapTimestamp,
        rawContent: content,
        sourceFilename: filename,
      },
    });
    await tx.pORecord.update({
      where: { id: record.id },
      data: success
        ? {
            status: 'SO_CREATED',
            statusChangedAt: new Date(),
            soNumber: parsed.soNumber,
            failureCode: null,
            failureMessage: null,
          }
        : {
            status: 'FAILED',
            statusChangedAt: new Date(),
            failureCode: parsed.errorCode ?? 'SAP_REJECTED',
            failureMessage: parsed.errorMessage ?? 'SAP rejected the order without a reason.',
          },
    });
  });

  await writeAudit({
    recordId: record.id,
    eventType: 'RESULT_INGESTED',
    message: success
      ? `SAP created Sales Order ${parsed.soNumber}`
      : `SAP rejected the order: ${parsed.errorCode ?? 'no code'} — ${parsed.errorMessage ?? 'no message'}`,
    after: { ...parsed },
    actorName: 'sap-result-watcher',
  });
  await writeAudit({
    recordId: record.id,
    eventType: 'STATUS_CHANGED',
    message: `SENT_TO_SAP → ${success ? 'SO_CREATED' : 'FAILED'}`,
    actorName: 'sap-result-watcher',
  });

  await removeMarker(path.dirname(sourcePath), filename);
  // FR-10.10 — archived, not deleted.
  await moveTo(env.paths.archive, sourcePath, filename);
  log.info({ filename, recordId: record.id, success }, 'result ingested');
}

/** One sweep of the inbound folder. FR-10.1. */
export async function scanResultFolder(): Promise<number> {
  await fs.mkdir(env.paths.inbound, { recursive: true });
  const entries = await fs.readdir(env.paths.inbound, { withFileTypes: true });
  let processed = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filename = entry.name;
    if (filename.startsWith('.')) continue;
    if (!DATA_EXTENSIONS.some((ext) => filename.toLowerCase().endsWith(ext))) continue;

    const sourcePath = path.join(env.paths.inbound, filename);

    try {
      if (!(await isComplete(env.paths.inbound, filename))) continue;

      // FR-10.9 — already seen this exact file; drop the leftovers and move on.
      const seen = await prisma.sapResult.findUnique({ where: { sourceFilename: filename } });
      if (seen) {
        await removeMarker(env.paths.inbound, filename);
        await moveTo(env.paths.archive, sourcePath, filename);
        continue;
      }

      const content = await fs.readFile(sourcePath, 'utf8');
      let parsed: ParsedResult;
      try {
        parsed = parseResultFile(filename, content);
      } catch (err) {
        const reason =
          err instanceof ResultParseError ? err.message : `Unreadable result file: ${(err as Error).message}`;
        // Fall back to the filename for a correlation ID so the quarantine row is traceable.
        const fromName = /RESULT_(PO-[A-Z0-9]+)_/i.exec(filename)?.[1] ?? 'UNKNOWN';
        await quarantine(filename, sourcePath, content, reason, fromName);
        processed++;
        continue;
      }

      await applyResult(filename, sourcePath, content, parsed);
      processed++;
    } catch (err) {
      log.error({ filename, err: (err as Error).message }, 'failed to process result file');
    }
  }

  return processed;
}

/**
 * FR-10.5 — a record must not sit in SENT_TO_SAP forever because SAP never answered.
 * A03 assumes a result always comes back; this is what happens when that assumption breaks.
 */
export async function sweepSlaTimeouts(): Promise<number> {
  const cutoff = new Date(Date.now() - env.SAP_SLA_TIMEOUT_MS);
  const stale = await prisma.pORecord.findMany({
    where: { status: 'SENT_TO_SAP', sentToSapAt: { lt: cutoff } },
    select: { id: true, correlationId: true, sentToSapAt: true },
  });

  for (const record of stale) {
    await prisma.pORecord.update({
      where: { id: record.id },
      data: {
        status: 'FAILED',
        statusChangedAt: new Date(),
        failureCode: 'NO_RESPONSE_FROM_SAP',
        failureMessage: `SAP did not return a result within ${Math.round(
          env.SAP_SLA_TIMEOUT_MS / 60000,
        )} minutes of submission.`,
      },
    });
    await writeAudit({
      recordId: record.id,
      eventType: 'SLA_TIMEOUT',
      message: `No result from SAP since ${record.sentToSapAt?.toISOString()}; marked FAILED.`,
      actorName: 'sap-result-watcher',
    });
    await writeAudit({
      recordId: record.id,
      eventType: 'STATUS_CHANGED',
      message: 'SENT_TO_SAP → FAILED (SLA timeout)',
      actorName: 'sap-result-watcher',
    });
    log.error({ recordId: record.id }, 'SLA timeout — no result from SAP');
  }

  return stale.length;
}
