import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { childLogger } from '../lib/logger.js';
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
