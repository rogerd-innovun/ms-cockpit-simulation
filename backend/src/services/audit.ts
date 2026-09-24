import type { Prisma } from '@prisma/client';
import { prisma } from '../db/client.js';
import type { Tx } from '../db/client.js';

/**
 * FR-13 — append-only audit trail. Every lifecycle event, field edit, approval and
 * integration file operation lands here, and nothing in the application updates or
 * deletes a row (FR-13.3).
 */
export type AuditEventType =
  | 'RECORD_UPLOADED'
  | 'RECORD_PUBLISHED'
  | 'RECORD_CANCELLED'
  | 'RECORD_DELETED'
  | 'EXTRACTION_STARTED'
  | 'EXTRACTION_SUCCEEDED'
  | 'EXTRACTION_FAILED'
  | 'EXTRACTION_RETRIED'
  | 'EXTRACTION_REQUEUED'
  | 'FIELD_EDITED'
  | 'LINE_ADDED'
  | 'LINE_DELETED'
  | 'WARNING_ACKNOWLEDGED'
  | 'APPROVED'
  | 'APPROVAL_REJECTED'
  | 'OUTBOUND_WRITTEN'
  | 'OUTBOUND_WRITE_FAILED'
  | 'RESULT_INGESTED'
  | 'RESULT_QUARANTINED'
  | 'RESULT_STALE_IGNORED'
  | 'SLA_TIMEOUT'
  | 'RESUBMITTED'
  | 'STATUS_CHANGED'
  | 'CONFIG_CHANGED';

export interface AuditInput {
  recordId?: string | null;
  eventType: AuditEventType;
  message?: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  /** Omit for system-initiated events. */
  actorId?: string | null;
  /** Component name when there is no user, e.g. "extraction-worker". */
  actorName?: string;
}

export async function writeAudit(input: AuditInput, tx?: Tx): Promise<void> {
  const client = tx ?? prisma;
  await client.auditEvent.create({
    data: {
      recordId: input.recordId ?? null,
      eventType: input.eventType,
      message: input.message,
      before: input.before,
      after: input.after,
      actorType: input.actorId ? 'USER' : 'SYSTEM',
      actorId: input.actorId ?? null,
      actorName: input.actorId ? null : (input.actorName ?? 'system'),
    },
  });
}
