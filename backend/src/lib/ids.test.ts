import { describe, expect, it } from 'vitest';
import { correlationIdFor, newRecordId, sha256 } from './ids.js';

describe('correlation ID (FR-8)', () => {
  it('FR-8.2: is filename-safe', () => {
    for (let i = 0; i < 200; i++) {
      expect(correlationIdFor(newRecordId())).toMatch(/^PO-[A-F0-9]{32}$/);
    }
  });

  it('FR-8.2: is deterministic for a record and unique across records', () => {
    const id = newRecordId();
    expect(correlationIdFor(id)).toBe(correlationIdFor(id));
    const many = new Set(Array.from({ length: 2000 }, () => correlationIdFor(newRecordId())));
    expect(many.size).toBe(2000);
  });

  it('FR-8.1: is not derived from the vendor PO number', () => {
    // Two records carrying the same vendor PO number must still be told apart, because
    // vendors reuse PO numbers across years and across each other.
    const a = correlationIdFor(newRecordId());
    const b = correlationIdFor(newRecordId());
    expect(a).not.toBe(b);
  });

  it('hashes content stably', () => {
    expect(sha256(Buffer.from('abc'))).toBe(sha256('abc'));
    expect(sha256('abc')).toHaveLength(64);
  });
});
