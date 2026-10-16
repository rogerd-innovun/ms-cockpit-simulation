import { describe, expect, it } from 'vitest';
import { computeDashboard, type DashInput, type DashRecord, type SavingAssumptions } from './dashboard.js';

const NOW = new Date('2026-10-10T12:00:00Z');
const A: SavingAssumptions = {
  manualMinutesPerPo: 4, manualMinutesPerLine: 1.5, reviewMinutesPerPo: 1.5, reviewMinutesPerLine: 0.25, minutesPerCorrection: 0.5,
};

const rec = (over: Partial<DashRecord> = {}): DashRecord => ({
  status: 'SO_CREATED', createdAt: new Date('2026-10-09T08:00:00Z'), statusChangedAt: new Date('2026-10-09T08:30:00Z'),
  currentAttempt: 1, lines: 4, read: true, fieldEdits: 0, lineChanges: 0, sentBack: 0, warningsAccepted: 0, sapRejections: 0,
  ...over,
});
const input = (records: DashRecord[], over: Partial<DashInput> = {}): DashInput => ({
  records, rejectionCodes: [], fields: { read: 0, corrected: 0, confidenceSum: 0, confidenceCount: 0 }, chartDays: 7, now: NOW, ...over,
});

describe('computeDashboard', () => {
  it('has nothing to report, and says null rather than 0%, when there are no records', () => {
    const d = computeDashboard(input([]), A);
    expect(d.uploaded).toBe(0);
    expect(d.straightThrough).toEqual({ count: 0, of: 0, rate: null });
    expect(d.minutesSaved.total).toBe(0);
    expect(d.minutesSaved.perPo).toBeNull();
    expect(d.quality.accuracy).toBeNull();
    expect(d.turnaround.medianMinutes).toBeNull();
    expect(d.daily).toHaveLength(7);
  });

  it('counts how far each PO got', () => {
    const d = computeDashboard(
      input([
        rec(),
        rec({ status: 'NEEDS_REVIEW', currentAttempt: 0 }),
        rec({ status: 'DRAFT', currentAttempt: 0, read: false }),
        rec({ status: 'EXTRACTION_FAILED', currentAttempt: 0, read: false }),
        rec({ status: 'FAILED', currentAttempt: 1 }),
      ]),
      A,
    );
    expect(d).toMatchObject({ uploaded: 5, read: 3, approved: 2, soCreated: 1 });
  });

  describe('straight-through rate', () => {
    it('is the share of approved POs nobody had to change', () => {
      const d = computeDashboard(
        input([
          rec(),
          rec(),
          rec({ fieldEdits: 2 }),
          rec({ lineChanges: 1 }), // a line added or removed is an edit too
          rec({ status: 'NEEDS_REVIEW', currentAttempt: 0, fieldEdits: 5 }), // not approved: not in the denominator
        ]),
        A,
      );
      expect(d.straightThrough).toEqual({ count: 2, of: 4, rate: 0.5 });
    });

    it('does not count a warning that was merely accepted as an edit', () => {
      const d = computeDashboard(input([rec({ warningsAccepted: 3 })]), A);
      expect(d.straightThrough.rate).toBe(1);
      expect(d.caught.warningsAccepted).toBe(3);
    });
  });

  describe('minutes saved (an estimate from stated assumptions)', () => {
    it('is manual keying time minus review time, per approved PO', () => {
      // 4 lines: manual 4 + 1.5×4 = 10; review 1.5 + 0.25×4 = 2.5 → 7.5 saved.
      const d = computeDashboard(input([rec()]), A);
      expect(d.minutesSaved.total).toBe(8); // 7.5 rounded
      expect(d.minutesSaved.perPo).toBe(7.5);
    });

    it('takes off the time spent on each correction', () => {
      // same PO, 3 corrected fields: review 2.5 + 3×0.5 = 4 → 6 saved.
      expect(computeDashboard(input([rec({ fieldEdits: 3 })]), A).minutesSaved.perPo).toBe(6);
    });

    it('never goes negative for a PO that took longer than keying it would have', () => {
      const d = computeDashboard(input([rec({ lines: 1, fieldEdits: 40 })]), A);
      expect(d.minutesSaved.total).toBe(0);
    });

    it('counts only POs a person approved, and carries its assumptions with it', () => {
      const d = computeDashboard(input([rec(), rec({ status: 'NEEDS_REVIEW', currentAttempt: 0 })]), A);
      expect(d.minutesSaved.perPo).toBe(7.5);
      expect(d.minutesSaved.assumptions).toEqual(A);
    });
  });

  it('counts what was caught before SAP', () => {
    const d = computeDashboard(
      input([
        rec({ sentBack: 2, fieldEdits: 3 }),
        rec({ sentBack: 1 }),
        rec({ fieldEdits: 1, warningsAccepted: 2 }),
        rec(),
      ]),
      A,
    );
    // Three of the four POs had something caught (the first sent back and corrected: counted once).
    expect(d.caught).toEqual({ recordsIntercepted: 3, sentBack: 3, recordsSentBack: 2, corrections: 4, recordsCorrected: 2, warningsAccepted: 2 });
  });

  it('groups SAP rejections by code, most common first, and counts the ones that recovered', () => {
    const d = computeDashboard(
      input(
        [
          rec({ sapRejections: 1 }), // rejected, then created
          rec({ status: 'FAILED', sapRejections: 2 }),
          rec(),
        ],
        { rejectionCodes: ['PRICING_ERROR', 'MATERIAL_NOT_FOUND', 'MATERIAL_NOT_FOUND'] },
      ),
      A,
    );
    expect(d.sapRejections).toEqual({
      total: 3,
      recordsRejected: 2,
      recovered: 1,
      byCode: [{ code: 'MATERIAL_NOT_FOUND', count: 2 }, { code: 'PRICING_ERROR', count: 1 }],
    });
  });

  it('measures field accuracy by what people actually corrected', () => {
    const d = computeDashboard(input([rec()], { fields: { read: 200, corrected: 6, confidenceSum: 190, confidenceCount: 200 } }), A);
    expect(d.quality.accuracy).toBeCloseTo(0.97);
    expect(d.quality.avgConfidence).toBeCloseTo(0.95);
  });

  it('reports the median turnaround from upload to Sales Order', () => {
    const at = (m: number) => ({ statusChangedAt: new Date(new Date('2026-10-09T08:00:00Z').getTime() + m * 60000) });
    expect(computeDashboard(input([rec(at(10)), rec(at(30)), rec(at(120))]), A).turnaround).toEqual({ medianMinutes: 30, of: 3 });
    expect(computeDashboard(input([rec(at(10)), rec(at(30))]), A).turnaround.medianMinutes).toBe(20);
    // POs not yet created have no turnaround.
    expect(computeDashboard(input([rec({ status: 'NEEDS_REVIEW', currentAttempt: 0 })]), A).turnaround.of).toBe(0);
  });

  describe('throughput by day (UTC)', () => {
    it('runs oldest to today, keeps empty days, and buckets uploads and completions separately', () => {
      const d = computeDashboard(
        input([
          rec({ createdAt: new Date('2026-10-08T23:00:00Z'), statusChangedAt: new Date('2026-10-09T01:00:00Z') }),
          rec({ createdAt: new Date('2026-10-10T09:00:00Z'), status: 'NEEDS_REVIEW', currentAttempt: 0 }),
          rec({ createdAt: new Date('2026-09-01T09:00:00Z'), statusChangedAt: new Date('2026-09-01T10:00:00Z') }), // outside the chart
        ]),
        A,
      );
      expect(d.daily.map((x) => x.date)).toEqual([
        '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10',
      ]);
      expect(d.daily.find((x) => x.date === '2026-10-08')).toMatchObject({ uploaded: 1, soCreated: 0 });
      expect(d.daily.find((x) => x.date === '2026-10-09')).toMatchObject({ uploaded: 0, soCreated: 1 });
      expect(d.daily.find((x) => x.date === '2026-10-10')).toMatchObject({ uploaded: 1, soCreated: 0 });
      expect(d.daily.find((x) => x.date === '2026-10-05')).toMatchObject({ uploaded: 0, soCreated: 0 });
    });
  });
});
