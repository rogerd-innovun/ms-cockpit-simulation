import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// notify() must do three things reliably: remember each state change once, work out who gets
// an email or a Teams message, and never let a failure here reach the code that called it.

let users: { id: string; email: string }[] = [];
let emailOff: { userId: string }[] = [];
const tx = { notificationEvent: { create: vi.fn() }, notificationDelivery: { createMany: vi.fn() } };
const prismaMock = {
  user: { findMany: vi.fn(async () => users) },
  notificationPreference: { findMany: vi.fn(async () => emailOff) },
  pORecord: { findUnique: vi.fn() },
  $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
};
vi.mock('../../db/client.js', () => ({ prisma: prismaMock }));

const ENV_KEYS = ['SMTP_HOST', 'SMTP_FROM', 'NOTIFY_TEAMS_WEBHOOK_URL', 'NOTIFY_TEAMS_KINDS'];

async function load(settings: Record<string, string> = {}) {
  Object.assign(process.env, settings);
  vi.resetModules();
  return import('./notify.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  users = [];
  emailOff = [];
  tx.notificationEvent.create.mockImplementation(async ({ data }) => ({ id: 'ev-1', ...data }));
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

const spec = { kind: 'REVIEW_NEEDED' as const, dedupeKey: 'REVIEW_NEEDED:r1:1', title: 't', body: 'b', recordId: 'r1' };

describe('notify', () => {
  it('records the event for the kind\'s audience, and queues nothing when no channel is set up', async () => {
    const { notify } = await load();
    expect(await notify(spec)).toBe('created');
    expect(tx.notificationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'REVIEW_NEEDED', dedupeKey: 'REVIEW_NEEDED:r1:1', roles: ['APPROVER', 'ADMIN'], userId: null }),
    });
    expect(tx.notificationDelivery.createMany).not.toHaveBeenCalled();
    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
  });

  it('is a no-op the second time it hears of the same state change (FR-14.5)', async () => {
    const { notify } = await load();
    tx.notificationEvent.create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    expect(await notify(spec)).toBe('duplicate');
    expect(tx.notificationDelivery.createMany).not.toHaveBeenCalled();
  });

  it('never throws: a database failure is reported as "failed" and nothing more', async () => {
    const { notify } = await load();
    tx.notificationEvent.create.mockRejectedValueOnce(new Error('connection lost'));
    await expect(notify(spec)).resolves.toBe('failed');
  });

  describe('email', () => {
    it('queues one email per person in the audience, to the role and to the named user', async () => {
      const { notify } = await load({ SMTP_HOST: 'smtp.test', SMTP_FROM: 'cockpit@test' });
      users = [{ id: 'a1', email: 'approver@x.test' }, { id: 'u1', email: 'uploader@x.test' }];
      await notify({ ...spec, userId: 'u1' });

      expect(prismaMock.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { OR: [{ role: { in: ['APPROVER', 'ADMIN'] } }, { id: 'u1' }] } }),
      );
      expect(tx.notificationDelivery.createMany).toHaveBeenCalledWith({
        data: [
          { eventId: 'ev-1', channel: 'EMAIL', recipient: 'approver@x.test' },
          { eventId: 'ev-1', channel: 'EMAIL', recipient: 'uploader@x.test' },
        ],
        skipDuplicates: true,
      });
    });

    it('leaves out anyone who switched email off for this kind', async () => {
      const { notify } = await load({ SMTP_HOST: 'smtp.test', SMTP_FROM: 'cockpit@test' });
      users = [{ id: 'a1', email: 'approver@x.test' }, { id: 'a2', email: 'quiet@x.test' }];
      emailOff = [{ userId: 'a2' }];
      await notify(spec);
      const sent = tx.notificationDelivery.createMany.mock.calls[0]![0].data.map((d: { recipient: string }) => d.recipient);
      expect(sent).toEqual(['approver@x.test']);
    });

    it('sends nothing by email without a server and a sender address', async () => {
      const { notify } = await load({ SMTP_HOST: 'smtp.test' }); // no SMTP_FROM
      users = [{ id: 'a1', email: 'approver@x.test' }];
      await notify(spec);
      expect(tx.notificationDelivery.createMany).not.toHaveBeenCalled();
    });

    it('a test (force) goes to the named person whatever their settings', async () => {
      const { notify } = await load({ SMTP_HOST: 'smtp.test', SMTP_FROM: 'cockpit@test' });
      users = [{ id: 'adm', email: 'admin@x.test' }];
      emailOff = [{ userId: 'adm' }];
      await notify({ ...spec, kind: 'INTEGRATION_ALERT', roles: [], userId: 'adm', force: true });
      expect(prismaMock.notificationPreference.findMany).not.toHaveBeenCalled();
      expect(tx.notificationDelivery.createMany.mock.calls[0]![0].data).toEqual([{ eventId: 'ev-1', channel: 'EMAIL', recipient: 'admin@x.test' }]);
    });
  });

  describe('Teams', () => {
    it('queues one message to the shared channel, not one per person', async () => {
      const { notify } = await load({ NOTIFY_TEAMS_WEBHOOK_URL: 'https://teams.test/hook' });
      await notify(spec);
      expect(tx.notificationDelivery.createMany.mock.calls[0]![0].data).toEqual([{ eventId: 'ev-1', channel: 'TEAMS', recipient: 'teams' }]);
    });

    it('only sends the kinds it was asked to', async () => {
      const { notify } = await load({ NOTIFY_TEAMS_WEBHOOK_URL: 'https://teams.test/hook', NOTIFY_TEAMS_KINDS: 'RECORD_FAILED, INTEGRATION_ALERT' });
      await notify(spec); // REVIEW_NEEDED: not in the list
      expect(tx.notificationDelivery.createMany).not.toHaveBeenCalled();
      await notify({ ...spec, kind: 'RECORD_FAILED', dedupeKey: 'k2' });
      expect(tx.notificationDelivery.createMany).toHaveBeenCalledTimes(1);
    });
  });
});

describe('notifyRecord', () => {
  const rec = (over: Record<string, unknown> = {}) => ({
    id: 'r1', uploadedById: 'u1', statusChangedAt: new Date('2026-10-04T10:00:00Z'), soNumber: null,
    failureCode: null, failureMessage: null,
    sourceDocument: { originalFilename: 'po-apex.pdf' },
    header: { poNumber: 'APX-118276', customerName: 'Apex Fastener Supply Inc.', poTotalValue: '4,942.00', currency: 'USD', _count: { lineItems: 4 } },
    ...over,
  });

  it('says what the record says: the PO, the customer, the lines and the value', async () => {
    const { notifyRecord } = await load();
    prismaMock.pORecord.findUnique.mockResolvedValueOnce(rec());
    await notifyRecord('REVIEW_NEEDED', 'r1');
    const data = tx.notificationEvent.create.mock.calls[0]![0].data;
    expect(data.title).toBe('PO APX-118276 is ready for review');
    expect(data.body).toBe('Apex Fastener Supply Inc. 4 lines. 4,942.00 USD.');
    // A PO ready for review is for the approvers; the uploader is not told.
    expect(data.userId).toBeNull();
  });

  it('tells the uploader about the kinds that are theirs, and only those', async () => {
    const { notifyRecord } = await load();
    const named: Record<string, string | null> = {};
    for (const kind of ['REVIEW_NEEDED', 'SENT_BACK', 'RECORD_FAILED', 'EXTRACTION_FAILED', 'SO_CREATED'] as const) {
      prismaMock.pORecord.findUnique.mockResolvedValueOnce(rec());
      await notifyRecord(kind, 'r1');
      named[kind] = tx.notificationEvent.create.mock.calls.at(-1)![0].data.userId;
    }
    expect(named).toEqual({ REVIEW_NEEDED: null, SENT_BACK: 'u1', RECORD_FAILED: 'u1', EXTRACTION_FAILED: 'u1', SO_CREATED: 'u1' });
  });

  it('keys the event on when the record entered its status, so a retried job repeats it and a resubmission does not', async () => {
    const { notifyRecord } = await load();
    prismaMock.pORecord.findUnique.mockResolvedValueOnce(rec());
    await notifyRecord('REVIEW_NEEDED', 'r1');
    prismaMock.pORecord.findUnique.mockResolvedValueOnce(rec({ statusChangedAt: new Date('2026-10-04T11:00:00Z') }));
    await notifyRecord('REVIEW_NEEDED', 'r1');
    const keys = tx.notificationEvent.create.mock.calls.map((c) => c[0].data.dedupeKey);
    expect(keys[0]).toBe(`REVIEW_NEEDED:r1:${new Date('2026-10-04T10:00:00Z').getTime()}`);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('a send-back carries its reason and its own key', async () => {
    const { notifyRecord } = await load();
    prismaMock.pORecord.findUnique.mockResolvedValueOnce(rec());
    await notifyRecord('SENT_BACK', 'r1', { detail: 'Approver sent it back: wrong ship-to', suffix: '1759572000000' });
    const data = tx.notificationEvent.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ title: 'PO APX-118276 was sent back', body: 'Approver sent it back: wrong ship-to', dedupeKey: 'SENT_BACK:r1:1759572000000' });
  });

  it('a SAP failure explains itself in plain words, from the same table the record page uses', async () => {
    const { notifyRecord } = await load();
    prismaMock.pORecord.findUnique.mockResolvedValueOnce(rec({ failureCode: 'CREDIT_LIMIT_EXCEEDED', failureMessage: 'Credit limit exceeded for customer C-1' }));
    await notifyRecord('RECORD_FAILED', 'r1');
    const data = tx.notificationEvent.create.mock.calls[0]![0].data;
    expect(data.title).toBe('PO APX-118276 failed in SAP (CREDIT_LIMIT_EXCEEDED)');
    expect(data.body).toContain("exceeds the customer's credit limit");
  });

  it('a Sales Order notice names the order', async () => {
    const { notifyRecord } = await load();
    prismaMock.pORecord.findUnique.mockResolvedValueOnce(rec({ soNumber: '4500387184' }));
    await notifyRecord('SO_CREATED', 'r1');
    expect(tx.notificationEvent.create.mock.calls[0]![0].data.title).toBe('Sales Order 4500387184 created for PO APX-118276');
  });

  it('falls back to the file name before anything has been read, and survives a missing record', async () => {
    const { notifyRecord } = await load();
    prismaMock.pORecord.findUnique.mockResolvedValueOnce(rec({ header: null }));
    await notifyRecord('EXTRACTION_FAILED', 'r1', { detail: 'Gemini returned 503' });
    expect(tx.notificationEvent.create.mock.calls[0]![0].data).toMatchObject({ title: 'Could not read po-apex.pdf', body: 'Gemini returned 503' });

    prismaMock.pORecord.findUnique.mockResolvedValueOnce(null);
    await expect(notifyRecord('REVIEW_NEEDED', 'gone')).resolves.toBe('failed');
  });
});
