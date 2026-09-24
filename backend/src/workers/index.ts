import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { childLogger } from '../lib/logger.js';
import { writeAudit } from '../services/audit.js';
import { runExtractionForRecord } from '../services/extraction/index.js';
import { scanResultFolder, sweepSlaTimeouts } from '../services/sap/resultWatcher.js';
import { submitToSap } from '../services/sap/outbound.js';

const log = childLogger('workers');

/**
 * Milestone 1 runs the workers in-process on a polling loop rather than on a queue.
 * The database is the queue: a record's status is the work item, so a restart mid-job
 * resumes correctly (NFR-2.4) without Redis in the stack. A real deployment with more
 * than one API instance needs `FOR UPDATE SKIP LOCKED` or a proper queue here.
 */

let running = false;
const timers: NodeJS.Timeout[] = [];

function loop(name: string, intervalMs: number, fn: () => Promise<void>) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || !running) return;
    busy = true;
    try {
      await fn();
    } catch (err) {
      log.error({ worker: name, err: (err as Error).message }, 'worker iteration failed');
    } finally {
      busy = false;
    }
  }, intervalMs);
  timers.push(timer);
}

/** FR-3.1 / FR-3.2 — pick up PUBLISHED records and extract them. */
async function extractionTick() {
  // NFR-2.4 — PROCESSING was the one status nothing recovered: it means this
  // process died mid-extraction (a deploy, a free-tier sleep, a crash). Once a
  // record has sat there longer than a full extraction with all its retries could
  // take, requeue it, so a restart resumes the work instead of stranding it.
  const stuckSince = new Date(
    Date.now() - env.EXTRACTION_TIMEOUT_MS * env.EXTRACTION_MAX_ATTEMPTS - 60_000,
  );
  const stuck = await prisma.pORecord.findMany({
    where: { status: 'PROCESSING', deletedAt: null, statusChangedAt: { lt: stuckSince } },
    select: { id: true },
  });
  for (const record of stuck) {
    await prisma.pORecord.update({
      where: { id: record.id },
      data: { status: 'PUBLISHED', statusChangedAt: new Date() },
    });
    await writeAudit({
      recordId: record.id,
      eventType: 'EXTRACTION_REQUEUED',
      message: 'Found stuck in PROCESSING after a restart; requeued for extraction.',
      actorName: 'extraction-worker',
    });
    await writeAudit({
      recordId: record.id,
      eventType: 'STATUS_CHANGED',
      message: 'PROCESSING → PUBLISHED (crash recovery)',
      actorName: 'extraction-worker',
    });
    log.warn({ recordId: record.id }, 'requeued a record stuck in PROCESSING');
  }

  const next = await prisma.pORecord.findFirst({
    where: { status: 'PUBLISHED', deletedAt: null },
    orderBy: { statusChangedAt: 'asc' },
    select: { id: true },
  });
  if (next) await runExtractionForRecord(next.id);
}

/**
 * FR-9 — recover approvals whose outbound write never happened, e.g. the process died
 * between the approval committing and the file being written.
 */
async function outboundTick() {
  const stuck = await prisma.pORecord.findMany({
    where: { status: 'APPROVED', deletedAt: null },
    select: { id: true },
    take: 5,
  });
  for (const record of stuck) await submitToSap(record.id);
}

export function startWorkers() {
  if (running) return;
  running = true;
  loop('extraction', env.EXTRACTION_POLL_MS, extractionTick);
  loop('outbound', 5000, outboundTick);
  loop('sap-results', env.SAP_RESULT_POLL_MS, async () => {
    await scanResultFolder();
  });
  loop('sla-sweep', 60_000, async () => {
    await sweepSlaTimeouts();
  });
  log.info(
    {
      extractionPollMs: env.EXTRACTION_POLL_MS,
      resultPollMs: env.SAP_RESULT_POLL_MS,
      provider: env.EXTRACTION_PROVIDER,
    },
    'workers started',
  );
}

export function stopWorkers() {
  running = false;
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}
