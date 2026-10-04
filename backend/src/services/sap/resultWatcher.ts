import fs from 'node:fs/promises';
import path from 'node:path';
import type { PORecord, Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import { assertTransition } from '../../domain/status.js';
import { childLogger } from '../../lib/logger.js';
import { writeAudit } from '../audit.js';
import { notifyIntegration, notifyRecord } from '../notifications/notify.js';
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
  // A second file with the same name on the same day is not a replacement: result files
  // are named after the correlation ID and attempt, so a re-delivery is exactly what
  // lands here, and both copies are evidence (FR-10.6, FR-10.10). Number it instead of
  // letting the rename overwrite the first.
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let target = path.join(dated, filename);
  for (let n = 1; await fs.access(target).then(() => true, () => false); n++) {
    target = path.join(dated, `${stem}.${n}${ext}`);
  }
  await fs.rename(sourcePath, target);
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
  // FR-14.3 — an unmatched or unreadable result is nobody's record to notice; Operations has to.
  await notifyIntegration(
    `quarantine:${filename}:${Date.now()}`,
    'A SAP result file could not be used',
    `${filename} was set aside: ${reason}`,
  );
  log.error({ filename, reason }, 'result file quarantined — needs operations attention');
}

/**
 * SAP says it created an order that this record cannot take. Nobody is looking at the record
 * when that happens, and the order now exists in SAP, so Operations is told (FR-14.3).
 */
async function warnOfUnlinkedOrder(recordId: string, parsed: ParsedResult, what: string): Promise<void> {
  await notifyIntegration(
    `unlinked-order:${parsed.correlationId}:${parsed.soNumber}`,
    'SAP created an order that no record is linked to',
    `Sales Order ${parsed.soNumber} is SAP's answer to ${what} of ${parsed.correlationId}. Check it before the record is approved again, or cancel it in SAP if it is a duplicate.`,
    recordId,
  );
}

/** How a result reads in the audit trail. */
function describeResult(parsed: ParsedResult): string {
  return parsed.outcome === 'SUCCESS'
    ? `SAP created Sales Order ${parsed.soNumber}`
    : `SAP rejected the order: ${parsed.errorCode ?? 'no code'} — ${parsed.errorMessage ?? 'no message'}`;
}

/** The stored copy of a result file (FR-10.11), whatever became of the record. */
function resultRow(
  record: { id: string; currentAttempt: number },
  parsed: ParsedResult,
  content: string,
  filename: string,
): Prisma.SapResultUncheckedCreateInput {
  return {
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
  };
}

/**
 * SAP answered the current attempt after the SLA sweep had already marked the record FAILED
 * with NO_RESPONSE_FROM_SAP. "Created" completes the record; a rejection replaces the
 * timeout with the real reason. Either way the record is claimed with a conditional update,
 * so if someone resubmitted in the meantime it is left alone and false is returned.
 */
async function applyLateAnswer(
  record: PORecord,
  filename: string,
  content: string,
  parsed: ParsedResult,
): Promise<boolean> {
  const success = parsed.outcome === 'SUCCESS';
  if (success) assertTransition('FAILED', 'SO_CREATED');

  const applied = await prisma.$transaction(async (tx) => {
    const claimed = await tx.pORecord.updateMany({
      where: {
        id: record.id,
        status: 'FAILED',
        failureCode: 'NO_RESPONSE_FROM_SAP',
        currentAttempt: record.currentAttempt,
      },
      data: success
        ? {
            status: 'SO_CREATED',
            statusChangedAt: new Date(),
            soNumber: parsed.soNumber,
            failureCode: null,
            failureMessage: null,
          }
        : {
            statusChangedAt: new Date(),
            failureCode: parsed.errorCode ?? 'SAP_REJECTED',
            failureMessage: parsed.errorMessage ?? 'SAP rejected the order without a reason.',
          },
    });
    if (claimed.count !== 1) return false;
    await tx.sapResult.create({ data: resultRow(record, parsed, content, filename) });
    return true;
  });
  if (!applied) return false;

  await writeAudit({
    recordId: record.id,
    eventType: 'RESULT_INGESTED',
    message: `${describeResult(parsed)}. It arrived after the ${Math.round(
      env.SAP_SLA_TIMEOUT_MS / 60000,
    )}-minute limit that had marked this record FAILED.`,
    after: { ...parsed },
    actorName: 'sap-result-watcher',
  });
  if (success) {
    await writeAudit({
      recordId: record.id,
      eventType: 'STATUS_CHANGED',
      message: 'FAILED → SO_CREATED (SAP answered after the timeout)',
      actorName: 'sap-result-watcher',
    });
  }
  log.warn({ filename, recordId: record.id, success }, 'SAP answered after the SLA timeout; result applied');
  await notifyRecord(success ? 'SO_CREATED' : 'RECORD_FAILED', record.id);
  return true;
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

  // FR-10.8 — a result for a superseded attempt must never move the record. It is still
  // kept, and its outcome goes in the audit message: an attempt-1 "created" arriving
  // while the record is on attempt 2 means SAP now holds an order this record does not
  // know about, and whoever reads the history needs to be able to see which one.
  if (parsed.attempt != null && parsed.attempt !== record.currentAttempt) {
    await prisma.sapResult.create({ data: resultRow(record, parsed, content, filename) });
    await writeAudit({
      recordId: record.id,
      eventType: 'RESULT_STALE_IGNORED',
      message: `Ignored result for attempt ${parsed.attempt}; the record is on attempt ${record.currentAttempt}. ${describeResult(parsed)}.`,
      after: { ...parsed },
      actorName: 'sap-result-watcher',
    });
    await removeMarker(path.dirname(sourcePath), filename);
    await moveTo(env.paths.archive, sourcePath, filename);
    log.warn({ filename, recordId: record.id }, 'stale result ignored');
    if (parsed.outcome === 'SUCCESS') await warnOfUnlinkedOrder(record.id, parsed, `an earlier attempt (${parsed.attempt})`);
    return;
  }

  if (record.status !== 'SENT_TO_SAP') {
    // FR-10.5 marks a record FAILED when SAP is merely slow, and that is a presumption. If
    // SAP then answers that very attempt, the answer is the fact. Nothing has touched the
    // record since the timeout (any resubmission would have moved it out of FAILED), so
    // the answer can be applied without guessing.
    if (
      record.status === 'FAILED' &&
      record.failureCode === 'NO_RESPONSE_FROM_SAP' &&
      (await applyLateAnswer(record, filename, content, parsed))
    ) {
      await removeMarker(path.dirname(sourcePath), filename);
      await moveTo(env.paths.archive, sourcePath, filename);
      return;
    }

    // Anywhere else (already SO_CREATED, cancelled, or reopened for rework after the
    // timeout) it cannot be applied, but it is not thrown away either: the row keeps the
    // Sales Order number and the audit message says what SAP did.
    await prisma.sapResult.create({ data: resultRow(record, parsed, content, filename) });
    await writeAudit({
      recordId: record.id,
      eventType: 'RESULT_STALE_IGNORED',
      message: `Result arrived while the record was in ${record.status}; no status change applied. ${describeResult(parsed)}.`,
      after: { ...parsed },
      actorName: 'sap-result-watcher',
    });
    await removeMarker(path.dirname(sourcePath), filename);
    await moveTo(env.paths.archive, sourcePath, filename);
    log.warn({ filename, recordId: record.id, status: record.status }, 'result arrived for a record that was not waiting for one');
    if (parsed.outcome === 'SUCCESS') await warnOfUnlinkedOrder(record.id, parsed, `a record that was ${record.status}`);
    return;
  }

  const success = parsed.outcome === 'SUCCESS';

  // FR-10.9 — the unique constraint on sourceFilename makes reprocessing the same file
  // a no-op rather than a duplicate status change.
  await prisma.$transaction(async (tx) => {
    await tx.sapResult.create({ data: resultRow(record, parsed, content, filename) });
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
  await notifyRecord(success ? 'SO_CREATED' : 'RECORD_FAILED', record.id);
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

      // FR-10.9 — already processed this exact file; drop the leftovers and move on.
      const seen = await prisma.sapResult.findUnique({ where: { sourceFilename: filename } });
      if (seen && !seen.quarantined) {
        await removeMarker(env.paths.inbound, filename);
        await moveTo(env.paths.archive, sourcePath, filename);
        continue;
      }
      if (seen) {
        // A quarantined file was never processed, so its name must not count as "seen".
        // Result files are named RESULT_<correlationId>_<attempt>, so when SAP fixes what
        // it sent and delivers it again it arrives under the same name — and treating
        // that as a duplicate would bin the correction and leave the record waiting for
        // the SLA timeout. The old row stays (quarantine is evidence) under a name that
        // can no longer collide.
        await prisma.sapResult.update({
          where: { id: seen.id },
          data: { sourceFilename: `${filename}~quarantined-${seen.id.slice(0, 8)}` },
        });
        await writeAudit({
          recordId: seen.recordId,
          eventType: 'RESULT_REDELIVERED',
          message: `${filename} arrived again after being quarantined (${seen.quarantineReason ?? 'no reason recorded'}); processing the new copy.`,
          actorName: 'sap-result-watcher',
        });
        log.warn({ filename }, 'result re-delivered after quarantine; processing the new copy');
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
    await notifyRecord('RECORD_FAILED', record.id);
    log.error({ recordId: record.id }, 'SLA timeout — no result from SAP');
  }

  return stale.length;
}
