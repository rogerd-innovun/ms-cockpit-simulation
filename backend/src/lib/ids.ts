import { randomUUID, createHash } from 'node:crypto';

/**
 * FR-8.1 — the correlation ID is derived from the internal record id, never from the
 * vendor's PO number, because vendors reuse PO numbers across years and across each other.
 * FR-8.2 — globally unique, immutable, and filename-safe.
 */
export function newRecordId(): string {
  return randomUUID();
}

export function correlationIdFor(recordId: string): string {
  return `PO-${recordId.replace(/-/g, '').toUpperCase()}`;
}

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}
