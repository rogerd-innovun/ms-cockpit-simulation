import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { env } from '../../config/env.js';
import { forbidden } from '../../lib/errors.js';
import { requireAuth } from '../../middleware/auth.js';
import { emailConfigured, teamsConfigured } from '../../services/notifications/channels.js';
import { inboxFor, markAllRead, preferencesFor, setPreference } from '../../services/notifications/inbox.js';
import { ALL_KINDS } from '../../services/notifications/kinds.js';
import { notify } from '../../services/notifications/notify.js';

/** FR-14 — the inbox, the settings, and what the outgoing channels are doing. */
export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get('/', async (req, res, next) => {
  try {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query);
    res.json(await inboxFor(req.user!, limit));
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post('/read', async (req, res, next) => {
  try {
    await markAllRead(req.user!.id);
    res.json(await inboxFor(req.user!));
  } catch (err) {
    next(err);
  }
});

notificationsRouter.get('/preferences', async (req, res, next) => {
  try {
    res.json({ preferences: await preferencesFor(req.user!) });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.put('/preferences', async (req, res, next) => {
  try {
    const body = z
      .object({
        kind: z.enum(ALL_KINDS as [string, ...string[]]),
        inApp: z.boolean().optional(),
        email: z.boolean().optional(),
      })
      .parse(req.body);
    const { kind, ...change } = body;
    res.json({ preferences: await setPreference(req.user!, kind as (typeof ALL_KINDS)[number], change) });
  } catch (err) {
    next(err);
  }
});

/**
 * What is switched on, and for Operations and Administrators how the last day went — the
 * thing to look at when someone says "I never got the email". Only booleans and counts: no
 * address, no secret, no webhook URL.
 */
notificationsRouter.get('/channels', async (req, res, next) => {
  try {
    const channels = {
      email: { configured: emailConfigured(), redirected: Boolean(env.NOTIFY_EMAIL_OVERRIDE_TO) },
      teams: { configured: teamsConfigured(), kinds: env.NOTIFY_TEAMS_KINDS.split(',').map((k) => k.trim()).filter(Boolean) },
    };
    let recent: Record<string, { sent: number; pending: number; failed: number; lastError: string | null }> | null = null;
    if (req.user!.role === 'ADMIN' || req.user!.role === 'OPERATIONS') {
      const since = new Date(Date.now() - 24 * 3600_000);
      const rows = await prisma.notificationDelivery.findMany({
        where: { event: { createdAt: { gte: since } } },
        select: { channel: true, status: true, lastError: true },
      });
      recent = {};
      for (const ch of ['EMAIL', 'TEAMS'] as const) {
        const mine = rows.filter((r) => r.channel === ch);
        recent[ch.toLowerCase()] = {
          sent: mine.filter((r) => r.status === 'SENT').length,
          pending: mine.filter((r) => r.status === 'PENDING').length,
          failed: mine.filter((r) => r.status === 'FAILED').length,
          lastError: mine.find((r) => r.lastError)?.lastError ?? null,
        };
      }
    }
    res.json({ ...channels, recent });
  } catch (err) {
    next(err);
  }
});

/** Sends a test through every configured channel, to the administrator who asked. */
notificationsRouter.post('/test', async (req, res, next) => {
  try {
    if (req.user!.role !== 'ADMIN') throw forbidden('Only an administrator can send a test notification.', 'NOT_AN_ADMIN');
    const result = await notify({
      kind: 'INTEGRATION_ALERT',
      dedupeKey: `test:${req.user!.id}:${Date.now()}`,
      title: 'Test notification',
      body: `${req.user!.name} asked for a test message to check that notifications reach you.`,
      roles: [],
      userId: req.user!.id,
      force: true,
    });
    res.status(result === 'created' ? 201 : 500).json({
      result,
      email: emailConfigured(),
      teams: teamsConfigured(),
    });
  } catch (err) {
    next(err);
  }
});
