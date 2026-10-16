import fs from 'node:fs/promises';
import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { childLogger } from '../lib/logger.js';
import { writeAudit } from '../services/audit.js';
import { deliverPending } from '../services/notifications/deliver.js';
import { notifyIntegration } from '../services/notifications/notify.js';
import { runExtractionForRecord } from '../services/extraction/index.js';
import { scanResultFolder, sweepSlaTimeouts } from '../services/sap/resultWatcher.js';
import { checkOutboundWritable, submitToSap } from '../services/sap/outbound.js';

const log = childLogger('workers');

/**
 * Milestone 1 runs the workers in-process on a polling loop rather than on a queue.
 * The database is the queue: a record's status is the work item, so a restart mid-job
 * resumes correctly (NFR-2.4) without Redis in the stack. A real deployment with more
 * than one API instance needs `FOR UPDATE SKIP LOCKED` or a proper queue here.
 */

let running = false;
const timers: NodeJS.Timeout[] = [];
/** When each loop's current iteration began, while it is running. */
const busySince = new Map<string, number>();

function loop(name: string, intervalMs: number, fn: () => Promise<void>) {
  const timer = setInterval(async () => {
    if (busySince.has(name) || !running) return;
    busySince.set(name, Date.now());
    try {
      await fn();
    } catch (err) {
      log.error({ worker: name, err: (err as Error).message }, 'worker iteration failed');
    } finally {
      busySince.delete(name);
    }
  }, intervalMs);
  timers.push(timer);
}

/** An outage is announced again at most this often, so a long one is not a flood. */
const REANNOUNCE_MS = 6 * 3600_000;
/** An iteration this long is not working, it is hung (a share that stopped answering, say). */
const STUCK_AFTER_MS = 5 * 60_000;

/**
 * FR-14.3 — the integration fails silently: a drop folder that cannot be written or a result
 * folder that has gone away looks like "nothing is happening". Checked every minute, announced
 * to Operations once per outage window. What a process cannot see is its own death; that is
 * for whatever watches /api/health from outside.
 */
async function integrationHealthTick() {
  const window = Math.floor(Date.now() / REANNOUNCE_MS);
  const outbound = await checkOutboundWritable();
  if (!outbound.ok) {
    await notifyIntegration(`health:outbound:${window}`, 'The SAP drop folder cannot be written', outbound.error ?? 'No reason was given.');
  }
  const inbound = await fs.access(env.paths.inbound).then(() => null, (e: Error) => e.message);
  if (inbound) await notifyIntegration(`health:inbound:${window}`, 'The SAP result folder cannot be read', inbound);

  for (const [name, since] of busySince) {
    if (name !== 'integration-health' && Date.now() - since > STUCK_AFTER_MS) {
      await notifyIntegration(
        `stuck:${name}:${window}`,
        `The ${name} worker looks stuck`,
        `One pass has been running for more than ${STUCK_AFTER_MS / 60000} minutes. Nothing behind it is moving until it ends or the service is restarted.`,
      );
    }
  }
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
  loop('notifications', env.NOTIFY_DELIVERY_POLL_MS, async () => {
    await deliverPending();
  });
  loop('integration-health', 60_000, integrationHealthTick);
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
