import type { POStatus } from '@prisma/client';

/**
 * What the one-page dashboard shows, computed from plain data so every number can be checked
 * without a database. Two rules keep it honest:
 *
 *  - It counts POs *uploaded in the period*, and follows each of them to wherever it got to.
 *    "Last 30 days" therefore means "the POs that arrived in the last 30 days", for every
 *    figure on the page, rather than a mix of things that happened in the period.
 *  - What is measured and what is assumed is never blurred. Straight-through rate, send-backs,
 *    corrections and turnaround are counted from the audit trail. Minutes saved is an estimate
 *    from stated assumptions (below), and the page says so.
 */

/** The assumptions behind "minutes saved". Configuration, not measurement. */
export interface SavingAssumptions {
  /** Keying a PO into SAP by hand: a fixed part (header, customer, terms)... */
  manualMinutesPerPo: number;
  /** ...and a part per line item. */
  manualMinutesPerLine: number;
  /** Checking what the cockpit read against the PDF: a fixed part... */
  reviewMinutesPerPo: number;
  /** ...a part per line... */
  reviewMinutesPerLine: number;
  /** ...and the time to fix each field the reviewer corrects. */
  minutesPerCorrection: number;
}

export interface DashRecord {
  status: POStatus;
  createdAt: Date;
  statusChangedAt: Date;
  /** FR-8.4 — 0 until first approved. Approved at least once means currentAttempt >= 1. */
  currentAttempt: number;
  lines: number;
  /** Extraction produced a reading (the record has a header), whatever became of it. */
  read: boolean;
  /** Counts from the audit trail for this record. */
  fieldEdits: number;
  lineChanges: number;
  sentBack: number;
  warningsAccepted: number;
  /** Times SAP rejected an attempt. */
  sapRejections: number;
}

export interface DashInput {
  records: DashRecord[];
  /** SAP error codes of every rejection of the cohort, one entry per rejection. */
  rejectionCodes: string[];
  /** Field-level accuracy over the cohort: values read vs values a person corrected. */
  fields: { read: number; corrected: number; confidenceSum: number; confidenceCount: number };
  /** Days shown on the throughput chart, ending today (UTC). */
  chartDays: number;
  now: Date;
}

export interface DashboardData {
  uploaded: number;
  /** The system produced a reading. */
  read: number;
  /** A person approved it at least once. */
  approved: number;
  /** SAP created the Sales Order. */
  soCreated: number;
  straightThrough: { count: number; of: number; rate: number | null };
  minutesSaved: { total: number; perPo: number | null; assumptions: SavingAssumptions };
  caught: {
    /** POs where a reviewer sent it back or corrected a field: something was caught before SAP. */
    recordsIntercepted: number;
    sentBack: number;
    recordsSentBack: number;
    corrections: number;
    recordsCorrected: number;
    warningsAccepted: number;
  };
  sapRejections: {
    total: number;
    recordsRejected: number;
    /** Rejected at least once and now have their Sales Order. */
    recovered: number;
    byCode: { code: string; count: number }[];
  };
  quality: { fieldsRead: number; fieldsCorrected: number; accuracy: number | null; avgConfidence: number | null };
  turnaround: { medianMinutes: number | null; of: number };
  daily: { date: string; uploaded: number; soCreated: number }[];
}

const ratio = (n: number, d: number) => (d === 0 ? null : n / d);
const round1 = (n: number) => Math.round(n * 10) / 10;

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export function computeDashboard(input: DashInput, assumptions: SavingAssumptions): DashboardData {
  const { records, now } = input;
  const approvedRecords = records.filter((r) => r.currentAttempt >= 1);
  const created = records.filter((r) => r.status === 'SO_CREATED');

  // Approved "as read": nobody changed a field, added a line or removed one. A person still
  // looked at it and approved it — that is the point — but did not have to touch the data.
  const untouched = approvedRecords.filter((r) => r.fieldEdits + r.lineChanges === 0);

  let minutes = 0;
  for (const r of approvedRecords) {
    const manual = assumptions.manualMinutesPerPo + assumptions.manualMinutesPerLine * r.lines;
    const review =
      assumptions.reviewMinutesPerPo +
      assumptions.reviewMinutesPerLine * r.lines +
      assumptions.minutesPerCorrection * r.fieldEdits;
    minutes += Math.max(0, manual - review);
  }

  const codeCounts = new Map<string, number>();
  for (const code of input.rejectionCodes) codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);

  const turnaround = created.map((r) => (r.statusChangedAt.getTime() - r.createdAt.getTime()) / 60000);

  // Throughput: one bar pair per UTC day, oldest first, today last, with the empty days kept
  // so a quiet day looks quiet instead of being skipped.
  const days: string[] = [];
  for (let i = input.chartDays - 1; i >= 0; i--) days.push(utcDay(new Date(now.getTime() - i * 86_400_000)));
  const daily = new Map(days.map((d) => [d, { date: d, uploaded: 0, soCreated: 0 }]));
  for (const r of records) {
    const up = daily.get(utcDay(r.createdAt));
    if (up) up.uploaded++;
    if (r.status === 'SO_CREATED') {
      const done = daily.get(utcDay(r.statusChangedAt));
      if (done) done.soCreated++;
    }
  }

  return {
    uploaded: records.length,
    read: records.filter((r) => r.read).length,
    approved: approvedRecords.length,
    soCreated: created.length,
    straightThrough: {
      count: untouched.length,
      of: approvedRecords.length,
      rate: ratio(untouched.length, approvedRecords.length),
    },
    minutesSaved: {
      total: Math.round(minutes),
      perPo: approvedRecords.length ? round1(minutes / approvedRecords.length) : null,
      assumptions,
    },
    caught: {
      recordsIntercepted: records.filter((r) => r.sentBack > 0 || r.fieldEdits > 0).length,
      sentBack: records.reduce((n, r) => n + r.sentBack, 0),
      recordsSentBack: records.filter((r) => r.sentBack > 0).length,
      corrections: records.reduce((n, r) => n + r.fieldEdits, 0),
      recordsCorrected: records.filter((r) => r.fieldEdits > 0).length,
      warningsAccepted: records.reduce((n, r) => n + r.warningsAccepted, 0),
    },
    sapRejections: {
      total: input.rejectionCodes.length,
      recordsRejected: records.filter((r) => r.sapRejections > 0).length,
      recovered: records.filter((r) => r.sapRejections > 0 && r.status === 'SO_CREATED').length,
      byCode: [...codeCounts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    },
    quality: {
      fieldsRead: input.fields.read,
      fieldsCorrected: input.fields.corrected,
      accuracy: input.fields.read === 0 ? null : 1 - input.fields.corrected / input.fields.read,
      avgConfidence: ratio(input.fields.confidenceSum, input.fields.confidenceCount),
    },
    turnaround: { medianMinutes: median(turnaround), of: turnaround.length },
    daily: [...daily.values()],
  };
}
