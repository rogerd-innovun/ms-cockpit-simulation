import type { NotificationKind, Role } from '@prisma/client';

/**
 * Who each kind of notification is for, and how it reads in the settings. FR-14.1 to FR-14.3.
 *
 * `roles` are told whoever they are; `uploader` also tells the person who uploaded the record.
 * Operations hears about every failure, because a failed order is theirs to chase even when
 * the uploader has already seen it (FR-11.7).
 */
export interface KindInfo {
  label: string;
  description: string;
  roles: readonly Role[];
  uploader: boolean;
}

export const KINDS: Record<NotificationKind, KindInfo> = {
  REVIEW_NEEDED: {
    label: 'A PO is ready for review',
    description: 'Extraction finished, or a rejected order was corrected and needs approving again.',
    roles: ['APPROVER', 'ADMIN'],
    uploader: false,
  },
  SENT_BACK: {
    label: 'Your PO was sent back',
    description: 'An approver returned a record you uploaded, with a reason.',
    roles: [],
    uploader: true,
  },
  RECORD_FAILED: {
    label: 'SAP rejected a PO, or did not answer',
    description: 'The order failed in SAP and needs correcting or chasing.',
    roles: ['OPERATIONS'],
    uploader: true,
  },
  EXTRACTION_FAILED: {
    label: 'A PDF could not be read',
    description: 'Extraction did not complete; it can be retried or entered by hand.',
    roles: ['OPERATIONS'],
    uploader: true,
  },
  SO_CREATED: {
    label: 'Your Sales Order was created',
    description: 'SAP confirmed an order for a PO you uploaded.',
    roles: [],
    uploader: true,
  },
  INTEGRATION_ALERT: {
    label: 'Integration problem',
    description: 'A result file nobody can match, a drop folder that cannot be written, or an order SAP created that no record is linked to.',
    roles: ['OPERATIONS', 'ADMIN'],
    uploader: false,
  },
};

export const ALL_KINDS = Object.keys(KINDS) as NotificationKind[];

/** The kinds that can ever reach someone with this role (anyone can be an uploader). */
export function kindsFor(role: Role): NotificationKind[] {
  return ALL_KINDS.filter((k) => KINDS[k].roles.includes(role) || KINDS[k].uploader);
}

/** Is this event for this user? Role match, or the event names them. */
export function isFor(event: { roles: readonly Role[]; userId: string | null }, user: { id: string; role: Role }): boolean {
  return event.roles.includes(user.role) || event.userId === user.id;
}
