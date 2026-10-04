import type { NotificationKind } from '@prisma/client';

/** What goes to a person or a channel for one event. Pure, so what is sent can be checked. */
export interface Outgoing {
  kind: NotificationKind;
  title: string;
  body: string;
  recordId: string | null;
}

/** The link in a message: the record, or the worklist for something that has no record. */
export function linkTo(baseUrl: string, recordId: string | null): string {
  const base = baseUrl.replace(/\/+$/, '');
  return recordId ? `${base}/records/${recordId}` : `${base}/`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function emailMessage(m: Outgoing, baseUrl: string, intendedFor?: string) {
  const link = linkTo(baseUrl, m.recordId);
  // When mail is redirected (a demo), the subject still says who it was meant for.
  const subject = `[PO Cockpit] ${m.title}${intendedFor ? ` (for ${intendedFor})` : ''}`;
  return {
    subject,
    text: `${m.title}\n\n${m.body}\n\nOpen it: ${link}\n`,
    html:
      `<p><b>${escapeHtml(m.title)}</b></p>` +
      `<p>${escapeHtml(m.body).replace(/\n/g, '<br>')}</p>` +
      `<p><a href="${escapeHtml(link)}">Open in the PO Cockpit</a></p>`,
  };
}

/**
 * A Teams message for a "Workflows" webhook: a `message` carrying one Adaptive Card. The older
 * Office 365 connector format (MessageCard) was retired in 2026 and is not used.
 */
export function teamsMessage(m: Outgoing, baseUrl: string) {
  const link = linkTo(baseUrl, m.recordId);
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: m.title, weight: 'Bolder', size: 'Medium', wrap: true },
            { type: 'TextBlock', text: m.body, wrap: true, spacing: 'Small' },
          ],
          actions: [{ type: 'Action.OpenUrl', title: m.recordId ? 'Open record' : 'Open the cockpit', url: link }],
        },
      },
    ],
  };
}
