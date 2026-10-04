import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The outbox: sends what is due, records each attempt, backs off on failure, and gives up after
// a bounded number of tries. A mail server being down must cost retries, never lose a message
// silently and never hold anything else up.

const NOW = new Date('2026-10-04T12:00:00Z');
let due: Record<string, unknown>[] = [];
const prismaMock = {
  notificationDelivery: {
    findMany: vi.fn(async () => due),
    updateMany: vi.fn(async () => ({ count: 1 })),
    update: vi.fn(async (_args: { where: { id: string }; data: Record<string, unknown> }) => ({})),
  },
};
vi.mock('../../db/client.js', () => ({ prisma: prismaMock }));

const ENV_KEYS = ['SMTP_HOST', 'SMTP_FROM', 'NOTIFY_TEAMS_WEBHOOK_URL', 'NOTIFY_MAX_ATTEMPTS'];
const email = vi.fn();
const teams = vi.fn();

async function load(settings: Record<string, string> = { SMTP_HOST: 'smtp.test', SMTP_FROM: 'c@test', NOTIFY_TEAMS_WEBHOOK_URL: 'https://teams.test/h' }) {
  Object.assign(process.env, settings);
  vi.resetModules();
  return import('./deliver.js');
}

const delivery = (over: Record<string, unknown> = {}) => ({
  id: 'd1', eventId: 'e1', channel: 'EMAIL', recipient: 'approver@x.test', status: 'PENDING', attempts: 0,
  nextAttemptAt: new Date('2026-10-04T11:59:00Z'), lastError: null,
  event: { kind: 'REVIEW_NEEDED', title: 'PO APX-1 is ready', body: 'Apex', recordId: 'r1' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  due = [];
  prismaMock.notificationDelivery.updateMany.mockResolvedValue({ count: 1 });
  email.mockResolvedValue(undefined);
  teams.mockResolvedValue(undefined);
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('backoff', () => {
  it('doubles from half a minute and stops growing at half an hour', async () => {
    const { backoffMs } = await load();
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(backoffMs(20)).toBe(30 * 60_000);
  });
});

describe('deliverPending', () => {
  it('sends an email and marks it sent', async () => {
    const { deliverPending } = await load();
    due = [delivery()];
    expect(await deliverPending({ email, teams }, NOW)).toBe(1);
    expect(email).toHaveBeenCalledWith('approver@x.test', { kind: 'REVIEW_NEEDED', title: 'PO APX-1 is ready', body: 'Apex', recordId: 'r1' });
    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: expect.objectContaining({ status: 'SENT', attempts: 1, lastError: null }),
    });
  });

  it('sends a Teams message through the Teams sender, not the email one', async () => {
    const { deliverPending } = await load();
    due = [delivery({ channel: 'TEAMS', recipient: 'teams' })];
    await deliverPending({ email, teams }, NOW);
    expect(teams).toHaveBeenCalledTimes(1);
    expect(email).not.toHaveBeenCalled();
  });

  it('leases a delivery before sending, so two passes cannot both send it', async () => {
    const { deliverPending } = await load();
    due = [delivery()];
    await deliverPending({ email, teams }, NOW);
    expect(prismaMock.notificationDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'PENDING', nextAttemptAt: new Date('2026-10-04T11:59:00Z') },
      data: { nextAttemptAt: new Date(NOW.getTime() + 2 * 60_000) },
    });
  });

  it('leaves alone a delivery another pass already took', async () => {
    const { deliverPending } = await load();
    due = [delivery()];
    prismaMock.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
    expect(await deliverPending({ email, teams }, NOW)).toBe(0);
    expect(email).not.toHaveBeenCalled();
  });

  it('a failure stays pending, with the reason and a later retry time', async () => {
    const { deliverPending } = await load();
    due = [delivery({ attempts: 1 })];
    email.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:587'));
    await deliverPending({ email, teams }, NOW);
    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { status: 'PENDING', attempts: 2, lastError: 'connect ECONNREFUSED 10.0.0.5:587', nextAttemptAt: new Date(NOW.getTime() + 60_000) },
    });
  });

  it('gives up after the configured number of tries and says why', async () => {
    const { deliverPending } = await load({ SMTP_HOST: 'smtp.test', SMTP_FROM: 'c@test', NOTIFY_MAX_ATTEMPTS: '3' });
    due = [delivery({ attempts: 2 })];
    email.mockRejectedValue(new Error('550 mailbox unavailable'));
    await deliverPending({ email, teams }, NOW);
    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: expect.objectContaining({ status: 'FAILED', attempts: 3, lastError: '550 mailbox unavailable' }),
    });
  });

  it('one failing delivery does not stop the next', async () => {
    const { deliverPending } = await load();
    due = [delivery({ id: 'bad', recipient: 'bad@x.test' }), delivery({ id: 'good', recipient: 'good@x.test' })];
    email.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);
    expect(await deliverPending({ email, teams }, NOW)).toBe(2);
    expect(email).toHaveBeenCalledTimes(2);
    expect(prismaMock.notificationDelivery.update).toHaveBeenLastCalledWith({ where: { id: 'good' }, data: expect.objectContaining({ status: 'SENT' }) });
  });

  it('a channel that has since been switched off fails with a reason instead of sending nowhere', async () => {
    const { deliverPending } = await load({}); // nothing configured any more
    due = [delivery()];
    await deliverPending({ email, teams }, NOW);
    expect(email).not.toHaveBeenCalled();
    expect(prismaMock.notificationDelivery.update.mock.calls[0]![0].data.lastError).toMatch(/no longer configured/);
  });
});
