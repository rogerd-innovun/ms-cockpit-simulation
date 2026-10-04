import type { NotificationKind } from './types';

/** The colour a kind of notification carries, matching the status it is about. */
export const KIND_TONE: Record<NotificationKind, string> = {
  REVIEW_NEEDED: 't-warn',
  SENT_BACK: 't-warn',
  RECORD_FAILED: 't-crit',
  EXTRACTION_FAILED: 't-crit',
  SO_CREATED: 't-ok',
  INTEGRATION_ALERT: 't-crit',
};
