import type { NotificationKind, Role } from '@prisma/client';
import { prisma } from '../../db/client.js';
import { childLogger } from '../../lib/logger.js';
import { mapSapError } from '../sap/errorMap.js';
import { emailConfigured, teamsConfigured, teamsWants } from './channels.js';
import { KINDS } from './kinds.js';

const log = childLogger('notifications');

export interface NotifySpec {
  kind: NotificationKind;
  /** Names the state change. The same key is the same event, however many times it is reported (FR-14.5). */
  dedupeKey: string;
  recordId?: string | null;
  title: string;
  body: string;
  /** Defaults to the kind's own roles. */
  roles?: readonly Role[];
  /** One named user in addition to the roles — usually the uploader. */
  userId?: string | null;
  /** Ignore people's preferences and the Teams kind filter. For the admin's "send a test". */
  force?: boolean;
}

export type NotifyResult = 'created' | 'duplicate' | 'failed';

/**
 * Records that something happened and queues the emails and Teams message for it. The in-app
 * inbox reads the event directly, so it needs no delivery rows.
 *
 * It never throws. A notification is a courtesy about work that has already been done; failing
 * to send one must not undo or hold up the extraction, approval or SAP result that caused it.
 * Call it after the change has been committed, not inside the transaction that made it.
 */
export async function notify(spec: NotifySpec): Promise<NotifyResult> {
  try {
    const roles = spec.roles ?? KINDS[spec.kind].roles;
    const deliveries: { channel: 'EMAIL' | 'TEAMS'; recipient: string }[] = [];

    if (emailConfigured()) {
      const audience = [...(roles.length ? [{ role: { in: [...roles] } }] : []), ...(spec.userId ? [{ id: spec.userId }] : [])];
      const users = audience.length ? await prisma.user.findMany({ where: { OR: audience }, select: { id: true, email: true } }) : [];
      const off = spec.force
        ? new Set<string>()
        : new Set(
            (
              await prisma.notificationPreference.findMany({
                where: { kind: spec.kind, email: false, userId: { in: users.map((u) => u.id) } },
                select: { userId: true },
              })
            ).map((p) => p.userId),
          );
      for (const u of users) if (!off.has(u.id)) deliveries.push({ channel: 'EMAIL', recipient: u.email });
    }
    if (teamsConfigured() && (spec.force || teamsWants(spec.kind))) deliveries.push({ channel: 'TEAMS', recipient: 'teams' });

    await prisma.$transaction(async (tx) => {
      const event = await tx.notificationEvent.create({
        data: {
          kind: spec.kind,
          dedupeKey: spec.dedupeKey,
          recordId: spec.recordId ?? null,
          title: spec.title,
          body: spec.body,
          roles: [...roles],
          userId: spec.userId ?? null,
        },
      });
      if (deliveries.length > 0) {
        await tx.notificationDelivery.createMany({
          data: deliveries.map((d) => ({ eventId: event.id, ...d })),
          skipDuplicates: true,
        });
      }
    });
    log.info({ kind: spec.kind, recordId: spec.recordId, deliveries: deliveries.length }, 'notification queued');
    return 'created';
  } catch (err) {
    // The unique key is how a repeat is recognised: the first report won, this one is nothing.
    if ((err as { code?: string }).code === 'P2002') return 'duplicate';
    log.error({ kind: spec.kind, err: (err as Error).message }, 'could not record a notification');
    return 'failed';
  }
}

// ------------------------------------------------------------ events about a record

export interface RecordNotice {
  /** Extra words for the body: why it was sent back, what extraction said. */
  detail?: string;
  /** Distinguishes repeats that do not change the record's status (each send-back). */
  suffix?: string;
  /** Replaces the default title. */
  title?: string;
}

/**
 * Raises the notification for something that happened to a record. Reads the record afresh,
 * so the message says what the record says now, and keys the event on when the record entered
 * its current status — which is what makes "REVIEW_NEEDED, again" a different event after a
 * resubmission and the same one after a retried job.
 */
export async function notifyRecord(kind: NotificationKind, recordId: string, extra: RecordNotice = {}): Promise<NotifyResult> {
  try {
    const rec = await prisma.pORecord.findUnique({
      where: { id: recordId },
      select: {
        id: true,
        uploadedById: true,
        statusChangedAt: true,
        soNumber: true,
        failureCode: true,
        failureMessage: true,
        sourceDocument: { select: { originalFilename: true } },
        header: {
          select: {
            poNumber: true,
            customerName: true,
            poTotalValue: true,
            currency: true,
            _count: { select: { lineItems: true } },
          },
        },
      },
    });
    if (!rec) return 'failed';

    const ref = rec.header?.poNumber ?? rec.sourceDocument?.originalFilename ?? 'a purchase order';
    const parts: string[] = [];
    // "Apex Fastener Supply Inc." already ends in a full stop; adding a second one reads as a typo.
    if (rec.header?.customerName) parts.push(`${rec.header.customerName.replace(/\.+$/, '')}.`);
    if (rec.header) parts.push(`${rec.header._count.lineItems} line${rec.header._count.lineItems === 1 ? '' : 's'}.`);
    if (rec.header?.poTotalValue) parts.push(`${rec.header.poTotalValue} ${rec.header.currency ?? ''}`.trim() + '.');
    const summary = parts.join(' ');

    let title: string;
    let body: string;
    switch (kind) {
      case 'REVIEW_NEEDED':
        title = `PO ${ref} is ready for review`;
        body = [summary, extra.detail].filter(Boolean).join(' ');
        break;
      case 'SENT_BACK':
        title = `PO ${ref} was sent back`;
        body = extra.detail ?? 'An approver sent it back for correction.';
        break;
      case 'RECORD_FAILED': {
        const failure = mapSapError(rec.failureCode, rec.failureMessage);
        title = `PO ${ref} failed in SAP${rec.failureCode ? ` (${rec.failureCode})` : ''}`;
        body = failure ? `${failure.explanation} ${failure.remedy}` : (rec.failureMessage ?? 'SAP rejected the order.');
        break;
      }
      case 'EXTRACTION_FAILED':
        title = `Could not read ${ref}`;
        body = extra.detail ?? 'Extraction did not complete. Retry it, or enter the data by hand.';
        break;
      case 'SO_CREATED':
        title = `Sales Order ${rec.soNumber ?? ''} created for PO ${ref}`.replace(/\s+/g, ' ');
        body = summary || 'SAP confirmed the order.';
        break;
      default:
        title = ref;
        body = extra.detail ?? '';
    }

    return await notify({
      kind,
      dedupeKey: `${kind}:${recordId}:${extra.suffix ?? rec.statusChangedAt.getTime()}`,
      recordId,
      title: extra.title ?? title,
      body,
      // The uploader is told only about the kinds that are theirs. A PO ready for review is the
      // approvers' to act on; telling the person who uploaded it too is just noise.
      userId: KINDS[kind].uploader ? rec.uploadedById : null,
    });
  } catch (err) {
    log.error({ kind, recordId, err: (err as Error).message }, 'could not compose a notification');
    return 'failed';
  }
}

/** A problem between the cockpit and SAP that belongs to no one user. */
export function notifyIntegration(dedupeKey: string, title: string, body: string, recordId?: string): Promise<NotifyResult> {
  return notify({ kind: 'INTEGRATION_ALERT', dedupeKey, title, body, recordId: recordId ?? null });
}
