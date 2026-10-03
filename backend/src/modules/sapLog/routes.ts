import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/client.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { requireAuth } from '../../middleware/auth.js';
import { writeAudit } from '../../services/audit.js';
import { LOG_API_NAME, callLogApi, logApiConfig } from '../../services/sap/logApi.js';
import { VbelnError, toVbeln } from '../../services/sap/vbeln.js';

/**
 * ZEE_API_LOG for one record: its Sales Order number goes to SAP as IT_SALEORDERS-VBELN.
 *
 * Every call is written to the audit trail with the request and SAP's answer, so the
 * history of what was asked and what came back survives without a table of its own.
 * Mounted ahead of the records router, so auth is per route rather than router-wide.
 */
export const sapLogRouter = Router();

async function loadRecord(id: string) {
  const record = await prisma.pORecord.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, status: true, soNumber: true },
  });
  if (!record) throw notFound('Record not found.');
  return record;
}

function vbelnOf(soNumber: string | null) {
  try {
    return { vbeln: toVbeln(soNumber), vbelnError: null };
  } catch (err) {
    if (err instanceof VbelnError) return { vbeln: null, vbelnError: err.message };
    throw err;
  }
}

sapLogRouter.get('/:id/sap-log', requireAuth, async (req, res, next) => {
  try {
    const record = await loadRecord(req.params.id!);
    const { mode, format } = logApiConfig();
    const events = await prisma.auditEvent.findMany({
      where: { recordId: record.id, eventType: 'SAP_LOG_API_CALLED' },
      orderBy: { timestamp: 'desc' },
      take: 10,
      include: { actor: { select: { name: true } } },
    });
    res.json({
      api: LOG_API_NAME,
      mode,
      format,
      soNumber: record.soNumber,
      ...vbelnOf(record.soNumber),
      calls: events.map((e) => ({
        ...(e.after as Record<string, unknown>),
        id: e.id,
        timestamp: e.timestamp,
        calledBy: e.actor?.name ?? e.actorName,
      })),
    });
  } catch (err) {
    next(err);
  }
});

sapLogRouter.post('/:id/sap-log', requireAuth, async (req, res, next) => {
  try {
    const record = await loadRecord(req.params.id!);
    const cfg = logApiConfig();
    if (cfg.mode === 'off') {
      throw new AppError(
        503,
        `${LOG_API_NAME} is switched off. Set SAP_LOG_API_MODE to mock or live in backend/.env.`,
        'SAP_LOG_API_OFF',
      );
    }
    if (record.status !== 'SO_CREATED' || !record.soNumber) {
      throw conflict('This record has no Sales Order yet, so there is no VBELN to send.', 'NO_SALES_ORDER');
    }
    const { vbeln, vbelnError } = vbelnOf(record.soNumber);
    if (!vbeln) throw badRequest(vbelnError!, 'INVALID_VBELN');

    const call = await callLogApi([vbeln], cfg);

    await writeAudit({
      recordId: record.id,
      eventType: 'SAP_LOG_API_CALLED',
      actorId: req.user!.id,
      message: `${LOG_API_NAME} (${cfg.mode}) for VBELN ${vbeln}: ${
        call.ok ? `HTTP ${call.httpStatus}` : (call.error ?? 'failed')
      }`,
      after: call as unknown as Prisma.InputJsonValue,
    });

    // SAP's answer, good or bad, is the result of this request — only a problem on our
    // side (switched off, no SO, bad VBELN) is an error status.
    res.json({ call });
  } catch (err) {
    next(err);
  }
});
