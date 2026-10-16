import type { NotificationKind, Prisma, Role } from '@prisma/client';
import { prisma } from '../../db/client.js';
import { badRequest } from '../../lib/errors.js';
import { ALL_KINDS, KINDS, kindsFor } from './kinds.js';

interface Viewer {
  id: string;
  role: Role;
}

/** What this user can see: events for their role or naming them, minus the kinds they muted in-app. */
async function visibleTo(user: Viewer): Promise<Prisma.NotificationEventWhereInput> {
  const muted = await prisma.notificationPreference.findMany({
    where: { userId: user.id, inApp: false },
    select: { kind: true },
  });
  return {
    OR: [{ roles: { has: user.role } }, { userId: user.id }],
    ...(muted.length ? { kind: { notIn: muted.map((m) => m.kind) } } : {}),
  };
}

/** FR-14.4 — the in-app inbox: the latest events for this user, and how many are new since they last looked. */
export async function inboxFor(user: Viewer, limit = 30) {
  const where = await visibleTo(user);
  const me = await prisma.user.findUnique({ where: { id: user.id }, select: { notificationsSeenAt: true } });
  const seen = me?.notificationsSeenAt ?? new Date(0);
  const [items, unread] = await Promise.all([
    prisma.notificationEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, kind: true, title: true, body: true, recordId: true, createdAt: true },
    }),
    prisma.notificationEvent.count({ where: { ...where, createdAt: { gt: seen } } }),
  ]);
  return { unread, items: items.map((i) => ({ ...i, unread: i.createdAt > seen })) };
}

/** "Mark all read" is a moment, not a flag per item: everything up to now counts as seen. */
export async function markAllRead(userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { notificationsSeenAt: new Date() } });
}

/** Every kind that can reach this user, with their settings (on, until they say otherwise). */
export async function preferencesFor(user: Viewer) {
  const rows = await prisma.notificationPreference.findMany({ where: { userId: user.id } });
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  return kindsFor(user.role).map((kind) => ({
    kind,
    label: KINDS[kind].label,
    description: KINDS[kind].description,
    inApp: byKind.get(kind)?.inApp ?? true,
    email: byKind.get(kind)?.email ?? true,
  }));
}

export async function setPreference(
  user: Viewer,
  kind: NotificationKind,
  change: { inApp?: boolean; email?: boolean },
) {
  if (!kindsFor(user.role).includes(kind)) {
    throw badRequest('That notification does not apply to your role.', 'NOT_APPLICABLE');
  }
  await prisma.notificationPreference.upsert({
    where: { userId_kind: { userId: user.id, kind } },
    create: { userId: user.id, kind, ...change },
    update: change,
  });
  return preferencesFor(user);
}

export { ALL_KINDS };
