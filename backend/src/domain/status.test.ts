import { describe, expect, it } from 'vitest';
import { POStatus } from '@prisma/client';
import { TRANSITIONS, assertTransition, canTransition, isEditable, isTerminal } from './status.js';

const ALL = Object.keys(TRANSITIONS) as POStatus[];

describe('status machine (docs/01-requirements.md §5)', () => {
  it('covers every status defined in the schema', () => {
    expect(ALL).toHaveLength(10);
  });

  it('INV-02: SO_CREATED and CANCELLED are terminal', () => {
    expect(TRANSITIONS.SO_CREATED).toEqual([]);
    expect(TRANSITIONS.CANCELLED).toEqual([]);
    expect(isTerminal('SO_CREATED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
  });

  it('INV-01: rejects every transition not declared', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const declared = TRANSITIONS[from].includes(to);
        expect(canTransition(from, to)).toBe(declared);
        if (!declared) expect(() => assertTransition(from, to)).toThrow(/Illegal status transition/);
      }
    }
  });

  it('the happy path runs Draft → SO Created', () => {
    const path: POStatus[] = [
      'DRAFT',
      'PUBLISHED',
      'PROCESSING',
      'NEEDS_REVIEW',
      'APPROVED',
      'SENT_TO_SAP',
      'SO_CREATED',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(() => assertTransition(path[i]!, path[i + 1]!)).not.toThrow();
    }
  });

  it('nothing reaches SAP without passing through APPROVED', () => {
    for (const from of ALL) {
      if (TRANSITIONS[from].includes('SENT_TO_SAP')) expect(from).toBe('APPROVED');
    }
  });

  it('NFR-2.4: a crash mid-extraction can be requeued (PROCESSING → PUBLISHED)', () => {
    expect(canTransition('PROCESSING', 'PUBLISHED')).toBe(true);
  });

  it('a failed order can be corrected but never auto-retried into SAP', () => {
    expect(TRANSITIONS.FAILED).toEqual(['NEEDS_REVIEW']);
    expect(TRANSITIONS.FAILED).not.toContain('SENT_TO_SAP');
    expect(TRANSITIONS.FAILED).not.toContain('APPROVED');
  });

  it('INV-05: values are only editable in NEEDS_REVIEW and EXTRACTION_FAILED', () => {
    for (const s of ALL) {
      expect(isEditable(s)).toBe(s === 'NEEDS_REVIEW' || s === 'EXTRACTION_FAILED');
    }
  });
});
