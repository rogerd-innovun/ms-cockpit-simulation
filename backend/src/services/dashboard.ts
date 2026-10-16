import type { Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { computeDashboard, type DashRecord, type SavingAssumptions } from '../domain/dashboard.js';

/** Periods the dashboard offers; 0 is "all time". */
export const DASHBOARD_PERIODS = [7, 30, 90, 0] as const;

const EDIT_EVENTS = ['FIELD_EDITED', 'LINE_ADDED', 'LINE_DELETED', 'APPROVAL_REJECTED', 'WARNING_ACKNOWLEDGED'];

export function savingAssumptions(): SavingAssumptions {
  return {
    manualMinutesPerPo: env.DASHBOARD_MANUAL_MIN_PER_PO,
    manualMinutesPerLine: env.DASHBOARD_MANUAL_MIN_PER_LINE,
    reviewMinutesPerPo: env.DASHBOARD_REVIEW_MIN_PER_PO,
    reviewMinutesPerLine: env.DASHBOARD_REVIEW_MIN_PER_LINE,
    minutesPerCorrection: env.DASHBOARD_MIN_PER_CORRECTION,
  };
}

/**
 * The dashboard for the POs uploaded in the last `days` days (0 = all of them). Reads are
 * aggregate queries over the audit trail and field provenance; nothing here writes. The
 * arithmetic itself is in domain/dashboard.ts, where it is tested without a database.
 */
export async function getDashboard(days: number) {
  const now = new Date();
  const since = days > 0 ? new Date(now.getTime() - days * 86_400_000) : null;
  const cohort: Prisma.PORecordWhereInput = { deletedAt: null, ...(since ? { createdAt: { gte: since } } : {}) };

  const [rows, events, results, fieldTotals, fieldsCorrected, pipeline] = await Promise.all([
    prisma.pORecord.findMany({
      where: cohort,
      select: {
        id: true, status: true, createdAt: true, statusChangedAt: true, currentAttempt: true,
        header: { select: { _count: { select: { lineItems: true } } } },
      },
    }),
    prisma.auditEvent.groupBy({
      by: ['recordId', 'eventType'],
      where: { record: cohort, eventType: { in: EDIT_EVENTS } },
      _count: { _all: true },
    }),
    prisma.sapResult.findMany({
      where: { record: cohort, outcome: 'ERROR', quarantined: false },
      select: { recordId: true, errorCode: true },
    }),
    // A "value read" is a field the model produced a reading for; manual entry has no confidence.
    prisma.fieldExtraction.aggregate({
      where: { record: cohort, confidence: { not: null } },
      _count: { _all: true },
      _sum: { confidence: true },
    }),
    prisma.fieldExtraction.count({ where: { record: cohort, confidence: { not: null }, editedAt: { not: null } } }),
    prisma.pORecord.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } }),
  ]);

  const perRecord = new Map<string, Record<string, number>>();
  for (const e of events) {
    if (!e.recordId) continue;
    const m = perRecord.get(e.recordId) ?? {};
    m[e.eventType] = e._count._all;
    perRecord.set(e.recordId, m);
  }
  const rejectionsByRecord = new Map<string, number>();
  for (const r of results) if (r.recordId) rejectionsByRecord.set(r.recordId, (rejectionsByRecord.get(r.recordId) ?? 0) + 1);

  const records: DashRecord[] = rows.map((r) => {
    const ev = perRecord.get(r.id) ?? {};
    return {
      status: r.status,
      createdAt: r.createdAt,
      statusChangedAt: r.statusChangedAt,
      currentAttempt: r.currentAttempt,
      lines: r.header?._count.lineItems ?? 0,
      read: r.header != null,
      fieldEdits: ev.FIELD_EDITED ?? 0,
      lineChanges: (ev.LINE_ADDED ?? 0) + (ev.LINE_DELETED ?? 0),
      sentBack: ev.APPROVAL_REJECTED ?? 0,
      warningsAccepted: ev.WARNING_ACKNOWLEDGED ?? 0,
      sapRejections: rejectionsByRecord.get(r.id) ?? 0,
    };
  });

  const data = computeDashboard(
    {
      records,
      rejectionCodes: results.map((r) => r.errorCode ?? 'UNKNOWN'),
      fields: {
        read: fieldTotals._count._all,
        corrected: fieldsCorrected,
        confidenceSum: fieldTotals._sum.confidence ?? 0,
        confidenceCount: fieldTotals._count._all,
      },
      chartDays: days > 0 ? Math.min(days, 30) : 30,
      now,
    },
    savingAssumptions(),
  );

  return {
    generatedAt: now.toISOString(),
    periodDays: days,
    ...data,
    // Right now, across everything: where the work currently sits.
    pipeline: Object.fromEntries(pipeline.map((p) => [p.status, p._count._all])) as Record<string, number>,
  };
}
