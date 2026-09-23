import type { POStatus } from './types';

export type Tone = 'ok' | 'info' | 'warn' | 'crit' | 'idle';

/**
 * NFR-4.4 — status is never carried by colour alone. Every status ships a tone,
 * a glyph and a written label, so the dark warn/crit pair (which sits in the
 * 6-8 CVD separation band) always has a second channel to lean on.
 */
export const STATUS_META: Record<POStatus, { label: string; tone: Tone; glyph: string }> = {
  DRAFT: { label: 'Draft', tone: 'idle', glyph: '○' },
  PUBLISHED: { label: 'Published', tone: 'info', glyph: '↗' },
  PROCESSING: { label: 'Processing', tone: 'info', glyph: '◐' },
  NEEDS_REVIEW: { label: 'Needs Review', tone: 'warn', glyph: '!' },
  EXTRACTION_FAILED: { label: 'Extraction Failed', tone: 'crit', glyph: '×' },
  APPROVED: { label: 'Approved', tone: 'ok', glyph: '✓' },
  SENT_TO_SAP: { label: 'Sent to SAP', tone: 'info', glyph: '→' },
  SO_CREATED: { label: 'SO Created', tone: 'ok', glyph: '✓' },
  FAILED: { label: 'Failed', tone: 'crit', glyph: '×' },
  CANCELLED: { label: 'Cancelled', tone: 'idle', glyph: '–' },
};

export const toneClass = (tone: Tone) => `t-${tone}`;
export const statusLabel = (s: POStatus) => STATUS_META[s].label;
export const statusTone = (s: POStatus) => STATUS_META[s].tone;

/**
 * The lifecycle as an operator reads it. Each stage collapses the states that
 * mean the same thing to a human watching the record move.
 */
export const STAGES: { key: string; label: string; covers: POStatus[] }[] = [
  { key: 'draft', label: 'Draft', covers: ['DRAFT'] },
  { key: 'extract', label: 'Extracting', covers: ['PUBLISHED', 'PROCESSING'] },
  { key: 'review', label: 'Review', covers: ['NEEDS_REVIEW', 'EXTRACTION_FAILED'] },
  { key: 'approved', label: 'Approved', covers: ['APPROVED'] },
  { key: 'sent', label: 'Sent to SAP', covers: ['SENT_TO_SAP'] },
  { key: 'so', label: 'SO Created', covers: ['SO_CREATED', 'FAILED'] },
];

export const stageIndexOf = (status: POStatus) =>
  Math.max(0, STAGES.findIndex((s) => s.covers.includes(status)));
