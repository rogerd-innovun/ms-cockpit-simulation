import { describe, expect, it } from 'vitest';
import { deriveSentBack } from './sentBack.js';

const at = (m: number) => new Date(Date.UTC(2026, 8, 30, 12, m));
const rejected = (m: number, reason = 'Customer code looks wrong', by: string | null = 'Ada Approver') => ({
  eventType: 'APPROVAL_REJECTED',
  message: reason,
  timestamp: at(m),
  actor: by ? { name: by } : null,
  actorName: by ? null : 'system',
});
const approved = (m: number) => ({ eventType: 'APPROVED', message: null, timestamp: at(m), actor: { name: 'Ada Approver' } });
const noise = (m: number) => ({ eventType: 'FIELD_EDITED', message: 'x', timestamp: at(m), actor: { name: 'Uploader' } });

describe('sent back (FR-7.12)', () => {
  it('surfaces the reason, who gave it and when, while the record is in review', () => {
    expect(deriveSentBack('NEEDS_REVIEW', [noise(1), rejected(2), noise(3)])).toEqual({
      reason: 'Customer code looks wrong',
      by: 'Ada Approver',
      at: at(2),
    });
  });

  it('keeps showing it after the uploader edits, until the record is approved', () => {
    expect(deriveSentBack('NEEDS_REVIEW', [rejected(2), noise(5), noise(6)])?.reason).toBe('Customer code looks wrong');
  });

  it('uses the latest rejection when there are several', () => {
    expect(deriveSentBack('NEEDS_REVIEW', [rejected(2, 'first'), rejected(9, 'second')])?.reason).toBe('second');
  });

  it('is gone once the record has been approved again', () => {
    expect(deriveSentBack('NEEDS_REVIEW', [rejected(2), approved(5)])).toBeNull();
  });

  it('a rejection after a later round trip to SAP shows again', () => {
    expect(deriveSentBack('NEEDS_REVIEW', [rejected(2), approved(5), rejected(20, 'again')])?.reason).toBe('again');
  });

  it('only applies in review', () => {
    for (const s of ['DRAFT', 'APPROVED', 'SENT_TO_SAP', 'SO_CREATED', 'FAILED', 'CANCELLED'] as const) {
      expect(deriveSentBack(s, [rejected(2)])).toBeNull();
    }
  });

  it('is null when nobody sent it back', () => {
    expect(deriveSentBack('NEEDS_REVIEW', [noise(1)])).toBeNull();
    expect(deriveSentBack('NEEDS_REVIEW', [])).toBeNull();
  });

  it('falls back to the system actor name when the approver is not a user row', () => {
    expect(deriveSentBack('NEEDS_REVIEW', [rejected(2, 'r', null)])?.by).toBe('system');
  });
});
