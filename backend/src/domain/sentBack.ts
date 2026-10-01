import type { POStatus } from '@prisma/client';

export interface SentBack {
  reason: string;
  by: string;
  at: Date;
}

interface AuditLike {
  eventType: string;
  message: string | null;
  timestamp: Date;
  actor?: { name: string } | null;
  actorName?: string | null;
}

/**
 * FR-7.12 — an approver sends a record back with a reason, and the person who has to fix
 * it needs that reason in front of them, not in the history. The reason lives in the
 * audit trail (it is the record of what happened); this reads it back.
 *
 * It applies while the record is in review and the rejection is newer than the last
 * approval: once the record has been approved again it has been dealt with, and a later
 * return to review (a SAP failure, say) is a different story with its own notice.
 */
export function deriveSentBack(status: POStatus, audit: AuditLike[]): SentBack | null {
  if (status !== 'NEEDS_REVIEW') return null;
  const latest = (type: string) =>
    audit.filter((a) => a.eventType === type).sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
  const rejected = latest('APPROVAL_REJECTED');
  if (!rejected) return null;
  const approved = latest('APPROVED');
  if (approved && approved.timestamp >= rejected.timestamp) return null;
  return {
    reason: rejected.message ?? '',
    by: rejected.actor?.name ?? rejected.actorName ?? 'an approver',
    at: rejected.timestamp,
  };
}
