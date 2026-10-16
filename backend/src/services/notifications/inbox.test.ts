import { beforeEach, describe, expect, it, vi } from 'vitest';

let muted: { kind: string }[] = [];
let prefs: { userId: string; kind: string; inApp: boolean; email: boolean }[] = [];
const SEEN = new Date('2026-10-04T10:00:00Z');
const events = [
  { id: 'e2', kind: 'REVIEW_NEEDED', title: 'new', body: '', recordId: 'r2', createdAt: new Date('2026-10-04T11:00:00Z') },
  { id: 'e1', kind: 'SO_CREATED', title: 'old', body: '', recordId: 'r1', createdAt: new Date('2026-10-04T09:00:00Z') },
];
const prismaMock = {
  notificationPreference: {
    findMany: vi.fn(async (args: { where: { inApp?: boolean } }) => (args.where.inApp === false ? muted : prefs)),
    upsert: vi.fn(async () => ({})),
  },
  user: {
    findUnique: vi.fn(async () => ({ notificationsSeenAt: SEEN })),
    update: vi.fn(async (_args: { where: { id: string }; data: { notificationsSeenAt: Date } }) => ({})),
  },
  notificationEvent: {
    findMany: vi.fn(async (_args: { where: Record<string, unknown> }) => events),
    count: vi.fn(async (_args: { where: Record<string, unknown> }) => 1),
  },
};
vi.mock('../../db/client.js', () => ({ prisma: prismaMock }));

const { inboxFor, markAllRead, preferencesFor, setPreference } = await import('./inbox.js');
const approver = { id: 'a1', role: 'APPROVER' as const };

beforeEach(() => {
  vi.clearAllMocks();
  muted = [];
  prefs = [];
});

describe('the in-app inbox (FR-14.4)', () => {
  it('shows events for the user\'s role or naming them', async () => {
    await inboxFor(approver);
    expect(prismaMock.notificationEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ roles: { has: 'APPROVER' } }, { userId: 'a1' }] }, orderBy: { createdAt: 'desc' } }),
    );
  });

  it('marks what arrived since they last looked as new, and counts it', async () => {
    const inbox = await inboxFor(approver);
    expect(inbox.items.map((i) => [i.id, i.unread])).toEqual([['e2', true], ['e1', false]]);
    expect(inbox.unread).toBe(1);
    expect(prismaMock.notificationEvent.count).toHaveBeenCalledWith({
      where: { OR: [{ roles: { has: 'APPROVER' } }, { userId: 'a1' }], createdAt: { gt: SEEN } },
    });
  });

  it('leaves out kinds the user switched off in-app', async () => {
    muted = [{ kind: 'SO_CREATED' }, { kind: 'SENT_BACK' }];
    await inboxFor(approver);
    expect(prismaMock.notificationEvent.findMany.mock.calls[0]![0].where).toEqual({
      OR: [{ roles: { has: 'APPROVER' } }, { userId: 'a1' }],
      kind: { notIn: ['SO_CREATED', 'SENT_BACK'] },
    });
  });

  it('"mark all read" moves the moment they last looked to now', async () => {
    const before = Date.now();
    await markAllRead('a1');
    const at = prismaMock.user.update.mock.calls[0]![0].data.notificationsSeenAt as Date;
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('preferences', () => {
  it('lists every kind that can reach the role, all on until changed', async () => {
    const list = await preferencesFor(approver);
    expect(list.map((p) => p.kind)).toContain('REVIEW_NEEDED');
    expect(list.map((p) => p.kind)).not.toContain('INTEGRATION_ALERT');
    expect(list.every((p) => p.inApp && p.email)).toBe(true);
  });

  it('reflects what the user has chosen', async () => {
    prefs = [{ userId: 'a1', kind: 'REVIEW_NEEDED', inApp: true, email: false }];
    const review = (await preferencesFor(approver)).find((p) => p.kind === 'REVIEW_NEEDED')!;
    expect(review).toMatchObject({ inApp: true, email: false });
  });

  it('saves a change to one channel and leaves the other alone', async () => {
    await setPreference(approver, 'REVIEW_NEEDED', { email: false });
    expect(prismaMock.notificationPreference.upsert).toHaveBeenCalledWith({
      where: { userId_kind: { userId: 'a1', kind: 'REVIEW_NEEDED' } },
      create: { userId: 'a1', kind: 'REVIEW_NEEDED', email: false },
      update: { email: false },
    });
  });

  it('refuses a setting for something that never reaches that role', async () => {
    await expect(setPreference(approver, 'INTEGRATION_ALERT', { email: false })).rejects.toMatchObject({ status: 400, code: 'NOT_APPLICABLE' });
    expect(prismaMock.notificationPreference.upsert).not.toHaveBeenCalled();
  });
});
