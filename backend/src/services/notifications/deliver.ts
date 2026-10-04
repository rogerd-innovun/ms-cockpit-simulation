import { env } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import { childLogger } from '../../lib/logger.js';
import { emailConfigured, sendEmail, sendTeams, teamsConfigured } from './channels.js';
import type { Outgoing } from './messages.js';

const log = childLogger('notification-delivery');

/** Failed sends are retried after 30 s, 1 min, 2 min... up to half an hour between tries. */
export const backoffMs = (attempts: number) => Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);

/** While one process is sending a delivery, no other will pick it up for this long. */
const LEASE_MS = 2 * 60_000;

export interface Senders {
  email: (to: string, m: Outgoing) => Promise<void>;
  teams: (m: Outgoing) => Promise<void>;
}

const real: Senders = { email: sendEmail, teams: (m) => sendTeams(m) };

/**
 * One pass over the outbox: sends what is due, records how each attempt went. The database is
 * the queue (D-1) — a restart mid-send leaves the row pending, and it is simply tried again;
 * a lease (a pushed-out `nextAttemptAt`) keeps two passes from sending the same one at once.
 * Returns how many deliveries it handled.
 */
export async function deliverPending(senders: Senders = real, now: Date = new Date()): Promise<number> {
  const due = await prisma.notificationDelivery.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: 'asc' },
    take: 10,
    include: { event: { select: { kind: true, title: true, body: true, recordId: true } } },
  });

  let handled = 0;
  for (const d of due) {
    const claimed = await prisma.notificationDelivery.updateMany({
      where: { id: d.id, status: 'PENDING', nextAttemptAt: d.nextAttemptAt },
      data: { nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
    });
    if (claimed.count !== 1) continue;
    handled++;

    const message: Outgoing = { kind: d.event.kind, title: d.event.title, body: d.event.body, recordId: d.event.recordId };
    try {
      if (d.channel === 'EMAIL') {
        if (!emailConfigured()) throw new Error('Email is no longer configured (SMTP_HOST / SMTP_FROM).');
        await senders.email(d.recipient, message);
      } else {
        if (!teamsConfigured()) throw new Error('Teams is no longer configured (NOTIFY_TEAMS_WEBHOOK_URL).');
        await senders.teams(message);
      }
      await prisma.notificationDelivery.update({
        where: { id: d.id },
        data: { status: 'SENT', sentAt: new Date(), attempts: d.attempts + 1, lastError: null },
      });
    } catch (err) {
      const attempts = d.attempts + 1;
      const giveUp = attempts >= env.NOTIFY_MAX_ATTEMPTS;
      const reason = (err as Error).message.slice(0, 500);
      await prisma.notificationDelivery.update({
        where: { id: d.id },
        data: {
          status: giveUp ? 'FAILED' : 'PENDING',
          attempts,
          lastError: reason,
          nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
        },
      });
      log.warn({ channel: d.channel, attempts, giveUp, reason }, 'notification delivery failed');
    }
  }
  return handled;
}
