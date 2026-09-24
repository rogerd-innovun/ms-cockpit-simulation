import { POStatus } from '@prisma/client';
import { conflict } from '../lib/errors.js';

/**
 * The status machine from docs/01-requirements.md §5.
 *
 * NFR-6.3 — declared in exactly one place. INV-01 — every transition not listed here is
 * rejected by the backend, not merely hidden in the UI.
 */
export const TRANSITIONS: Record<POStatus, readonly POStatus[]> = {
  DRAFT: ['PUBLISHED', 'CANCELLED'],
  PUBLISHED: ['PROCESSING'],
  // PROCESSING → PUBLISHED is crash recovery (NFR-2.4): only a process death mid-
  // extraction leaves a record in PROCESSING, and requeueing it is the resume.
  PROCESSING: ['NEEDS_REVIEW', 'EXTRACTION_FAILED', 'PUBLISHED'],
  NEEDS_REVIEW: ['APPROVED', 'CANCELLED'],
  EXTRACTION_FAILED: ['PROCESSING', 'NEEDS_REVIEW', 'CANCELLED'],
  APPROVED: ['SENT_TO_SAP', 'NEEDS_REVIEW'],
  SENT_TO_SAP: ['SO_CREATED', 'FAILED'],
  SO_CREATED: [], // INV-02 — terminal
  FAILED: ['NEEDS_REVIEW'],
  CANCELLED: [], // INV-02 — terminal
} as const;

/** INV-02 */
export const TERMINAL_STATUSES: readonly POStatus[] = ['SO_CREATED', 'CANCELLED'];

/** INV-05 — extracted values are only mutable in these states. */
export const EDITABLE_STATUSES: readonly POStatus[] = ['NEEDS_REVIEW', 'EXTRACTION_FAILED'];

export function canTransition(from: POStatus, to: POStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: POStatus, to: POStatus): void {
  if (!canTransition(from, to)) {
    throw conflict(
      `Illegal status transition ${from} → ${to}. Allowed from ${from}: ${
        TRANSITIONS[from].join(', ') || '(none — terminal)'
      }`,
      'ILLEGAL_TRANSITION',
      { from, to, allowed: TRANSITIONS[from] },
    );
  }
}

export function isTerminal(status: POStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isEditable(status: POStatus): boolean {
  return EDITABLE_STATUSES.includes(status);
}

/** Human-facing labels for the UI and audit messages. */
export const STATUS_LABELS: Record<POStatus, string> = {
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  PROCESSING: 'Processing',
  NEEDS_REVIEW: 'Needs Review',
  EXTRACTION_FAILED: 'Extraction Failed',
  APPROVED: 'Approved',
  SENT_TO_SAP: 'Sent to SAP',
  SO_CREATED: 'SO Created',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};
