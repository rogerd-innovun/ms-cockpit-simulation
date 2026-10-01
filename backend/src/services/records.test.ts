import { describe, expect, it, vi } from 'vitest';

// These tests are about who is allowed to act, so the database is replaced with a stub
// that fails loudly: a refused role must be refused before anything is read.
const findFirst = vi.fn();
vi.mock('../db/client.js', () => ({
  prisma: new Proxy({}, { get: () => ({ findFirst }) }),
}));

const { rejectRecord } = await import('./records.js');

const actor = (role: 'UPLOADER' | 'OPERATIONS' | 'APPROVER' | 'ADMIN') => ({ id: 'u1', role, name: 'Test' });

describe('rejectRecord (FR-7.12)', () => {
  it.each(['UPLOADER', 'OPERATIONS'] as const)('refuses a %s before touching the record', async (role) => {
    findFirst.mockClear();
    await expect(rejectRecord(actor(role), 'r1', 'wrong customer')).rejects.toMatchObject({
      status: 403,
      code: 'NOT_AN_APPROVER',
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it.each(['APPROVER', 'ADMIN'] as const)('lets an %s through to the record lookup', async (role) => {
    findFirst.mockReset();
    findFirst.mockResolvedValue(null); // no such record -> the 404 that follows the role check
    await expect(rejectRecord(actor(role), 'r1', 'wrong customer')).rejects.toMatchObject({ status: 404 });
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('still requires a reason from an approver', async () => {
    await expect(rejectRecord(actor('APPROVER'), 'r1', '   ')).rejects.toMatchObject({
      status: 400,
      code: 'REASON_REQUIRED',
    });
  });
});
