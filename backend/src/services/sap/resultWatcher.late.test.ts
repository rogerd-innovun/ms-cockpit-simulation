import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A record is marked FAILED (NO_RESPONSE_FROM_SAP) when SAP is slow. These tests are about
// the answer that arrives after that: it must be kept, its Sales Order number must be
// findable, and where nothing has touched the record since, it must complete it.

const CORR = 'PO-ABCDEF0123456789ABCDEF0123456789';

let record: Record<string, unknown> | null;
const tx = { pORecord: { updateMany: vi.fn() }, sapResult: { create: vi.fn() } };
const prismaMock = {
  pORecord: { findUnique: vi.fn(async () => record), update: vi.fn() },
  sapResult: { findUnique: vi.fn(async () => null), create: vi.fn() },
  $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
};
const writeAudit = vi.fn();

vi.mock('../../db/client.js', () => ({ prisma: prismaMock }));
vi.mock('../audit.js', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));

const roots: string[] = [];

/** env is read once at import, so each scenario points the process at its own folders. */
async function load() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-late-'));
  roots.push(root);
  Object.assign(process.env, { INTEGRATION_ROOT: root, COMPLETENESS_CONVENTION: 'rename', SAP_SLA_TIMEOUT_MS: String(60 * 60 * 1000) });
  vi.resetModules();
  const mod = await import('./resultWatcher.js');
  const inbound = path.join(root, 'inbound');
  await fs.mkdir(inbound, { recursive: true });
  return { ...mod, inbound };
}

async function deliver(inbound: string, attempt: number, outcome: 'SUCCESS' | 'ERROR') {
  const row =
    outcome === 'SUCCESS'
      ? [CORR, attempt, 'SUCCESS', '4500387184', '', '', '2026-10-04T03:44:19Z']
      : [CORR, attempt, 'ERROR', '', 'CREDIT_LIMIT_EXCEEDED', 'Credit limit exceeded for customer C-1', '2026-10-04T03:44:19Z'];
  const name = `RESULT_${CORR}_${attempt}.csv`;
  await fs.writeFile(
    path.join(inbound, name),
    `CORRELATION_ID,ATTEMPT,STATUS,SO_NUMBER,ERROR_CODE,ERROR_MESSAGE,SAP_TIMESTAMP\n${row.join(',')}\n`,
  );
  return name;
}

const timedOut = (over: Record<string, unknown> = {}) => ({
  id: 'r1', correlationId: CORR, status: 'FAILED', currentAttempt: 1,
  failureCode: 'NO_RESPONSE_FROM_SAP', failureMessage: 'SAP did not return a result within 60 minutes of submission.',
  soNumber: null, ...over,
});

const auditOf = (eventType: string) =>
  writeAudit.mock.calls.map((c) => c[0] as { eventType: string; message?: string }).filter((a) => a.eventType === eventType);

beforeEach(() => {
  vi.clearAllMocks();
  record = timedOut();
  tx.pORecord.updateMany.mockResolvedValue({ count: 1 });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
  for (const k of ['INTEGRATION_ROOT', 'COMPLETENESS_CONVENTION', 'SAP_SLA_TIMEOUT_MS']) delete process.env[k];
});

describe('SAP answers after the SLA timeout (FR-10.5)', () => {
  it('"created" completes the record: SO_CREATED, the number stored, the answer kept', async () => {
    const { scanResultFolder, inbound } = await load();
    const name = await deliver(inbound, 1, 'SUCCESS');

    expect(await scanResultFolder()).toBe(1);

    // Claimed conditionally, so a resubmission in the meantime wins.
    expect(tx.pORecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', status: 'FAILED', failureCode: 'NO_RESPONSE_FROM_SAP', currentAttempt: 1 },
      data: expect.objectContaining({ status: 'SO_CREATED', soNumber: '4500387184', failureCode: null, failureMessage: null }),
    });
    expect(tx.sapResult.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ recordId: 'r1', soNumber: '4500387184', outcome: 'SUCCESS', attempt: 1, sourceFilename: name }),
    });
    const ingested = auditOf('RESULT_INGESTED');
    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.message).toContain('4500387184');
    expect(ingested[0]!.message).toContain('after the 60-minute limit');
    expect(auditOf('STATUS_CHANGED').map((a) => a.message)).toEqual(['FAILED → SO_CREATED (SAP answered after the timeout)']);
    // Consumed and archived, not left to be read twice.
    expect(await fs.readdir(inbound)).not.toContain(name);
  });

  it('a late rejection replaces the timeout with SAP\'s own reason and leaves the record FAILED', async () => {
    const { scanResultFolder, inbound } = await load();
    await deliver(inbound, 1, 'ERROR');

    await scanResultFolder();

    expect(tx.pORecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failureCode: 'CREDIT_LIMIT_EXCEEDED', failureMessage: 'Credit limit exceeded for customer C-1' }),
      }),
    );
    const data = tx.pORecord.updateMany.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty('status');
    expect(auditOf('STATUS_CHANGED')).toHaveLength(0);
    expect(auditOf('RESULT_INGESTED')[0]!.message).toContain('CREDIT_LIMIT_EXCEEDED');
  });

  it('if the record was resubmitted a moment ago, it is left alone but the answer is still kept', async () => {
    const { scanResultFolder, inbound } = await load();
    tx.pORecord.updateMany.mockResolvedValue({ count: 0 });
    await deliver(inbound, 1, 'SUCCESS');

    await scanResultFolder();

    expect(tx.sapResult.create).not.toHaveBeenCalled(); // rolled back with the claim
    expect(prismaMock.sapResult.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ recordId: 'r1', soNumber: '4500387184' }),
    });
    const stale = auditOf('RESULT_STALE_IGNORED');
    expect(stale).toHaveLength(1);
    expect(stale[0]!.message).toContain('Sales Order 4500387184');
  });
});

describe('answers that cannot be applied are still kept, with the order number readable', () => {
  it('a record that failed for another reason is not completed by a stray "created"', async () => {
    record = timedOut({ failureCode: 'CREDIT_LIMIT_EXCEEDED' });
    const { scanResultFolder, inbound } = await load();
    await deliver(inbound, 1, 'SUCCESS');

    await scanResultFolder();

    expect(tx.pORecord.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.sapResult.create).toHaveBeenCalled();
    expect(auditOf('RESULT_STALE_IGNORED')[0]!.message).toContain('4500387184');
  });

  it('a record reopened for rework after the timeout keeps the answer and does not change status', async () => {
    record = timedOut({ status: 'NEEDS_REVIEW' });
    const { scanResultFolder, inbound } = await load();
    await deliver(inbound, 1, 'SUCCESS');

    await scanResultFolder();

    expect(tx.pORecord.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.pORecord.update).not.toHaveBeenCalled();
    expect(prismaMock.sapResult.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ soNumber: '4500387184', attempt: 1 }),
    });
    expect(auditOf('RESULT_STALE_IGNORED')[0]!.message).toContain('NEEDS_REVIEW');
    expect(auditOf('RESULT_STALE_IGNORED')[0]!.message).toContain('4500387184');
  });

  it('an answer for an earlier attempt names the order SAP created', async () => {
    record = timedOut({ status: 'SENT_TO_SAP', currentAttempt: 2, failureCode: null });
    const { scanResultFolder, inbound } = await load();
    await deliver(inbound, 1, 'SUCCESS');

    await scanResultFolder();

    expect(prismaMock.pORecord.update).not.toHaveBeenCalled();
    expect(tx.pORecord.updateMany).not.toHaveBeenCalled();
    const stale = auditOf('RESULT_STALE_IGNORED');
    expect(stale[0]!.message).toContain('attempt 1');
    expect(stale[0]!.message).toContain('attempt 2');
    expect(stale[0]!.message).toContain('4500387184');
  });
});
