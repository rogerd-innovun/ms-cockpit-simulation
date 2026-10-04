import { describe, expect, it } from 'vitest';
import { ALL_KINDS, KINDS, isFor, kindsFor } from './kinds.js';
import { emailMessage, linkTo, teamsMessage } from './messages.js';

describe('who each notification is for (FR-14.1 to 14.3)', () => {
  it('approvers hear that a PO is ready; the uploader hears about their own records', () => {
    expect(KINDS.REVIEW_NEEDED.roles).toEqual(['APPROVER', 'ADMIN']);
    expect(KINDS.SO_CREATED).toMatchObject({ roles: [], uploader: true });
    expect(KINDS.SENT_BACK).toMatchObject({ roles: [], uploader: true });
  });

  it('Operations hears about every failure, and about integration problems', () => {
    expect(KINDS.RECORD_FAILED.roles).toContain('OPERATIONS');
    expect(KINDS.EXTRACTION_FAILED.roles).toContain('OPERATIONS');
    expect(KINDS.INTEGRATION_ALERT.roles).toEqual(['OPERATIONS', 'ADMIN']);
  });

  it('shows each role only the notifications that can reach it', () => {
    expect(kindsFor('OPERATIONS')).toContain('INTEGRATION_ALERT');
    expect(kindsFor('APPROVER')).toContain('REVIEW_NEEDED');
    expect(kindsFor('APPROVER')).not.toContain('INTEGRATION_ALERT');
    expect(kindsFor('UPLOADER')).not.toContain('REVIEW_NEEDED');
    expect(kindsFor('UPLOADER')).toEqual(expect.arrayContaining(['SO_CREATED', 'SENT_BACK', 'RECORD_FAILED']));
    for (const k of kindsFor('ADMIN')) expect(ALL_KINDS).toContain(k);
  });

  it('an event is for a user by role or by name, and for nobody else', () => {
    const ev = { roles: ['APPROVER'] as const, userId: 'u-uploader' };
    expect(isFor(ev, { id: 'a', role: 'APPROVER' })).toBe(true);
    expect(isFor(ev, { id: 'u-uploader', role: 'UPLOADER' })).toBe(true);
    expect(isFor(ev, { id: 'x', role: 'UPLOADER' })).toBe(false);
    expect(isFor({ roles: [], userId: null }, { id: 'a', role: 'ADMIN' })).toBe(false);
  });
});

describe('what is sent', () => {
  const m = { kind: 'REVIEW_NEEDED' as const, title: 'PO APX-1 is ready for review', body: 'Apex <Fasteners> & Co. 4 lines.', recordId: 'rec-1' };

  it('links to the record, or to the worklist when there is none', () => {
    expect(linkTo('https://po.example.com/', 'rec-1')).toBe('https://po.example.com/records/rec-1');
    expect(linkTo('https://po.example.com', null)).toBe('https://po.example.com/');
  });

  it('builds an email with a link and no markup injected from the PO text', () => {
    const e = emailMessage(m, 'https://po.example.com');
    expect(e.subject).toBe('[PO Cockpit] PO APX-1 is ready for review');
    expect(e.text).toContain('https://po.example.com/records/rec-1');
    expect(e.html).toContain('Apex &lt;Fasteners&gt; &amp; Co.');
    expect(e.html).not.toContain('<Fasteners>');
  });

  it('says who a redirected email was meant for', () => {
    expect(emailMessage(m, 'https://x', 'approver@cockpit.local').subject).toContain('(for approver@cockpit.local)');
  });

  it('builds a Teams message as a Workflows webhook expects it: an Adaptive Card in a message', () => {
    const t = teamsMessage(m, 'https://po.example.com');
    expect(t.type).toBe('message');
    expect(t.attachments).toHaveLength(1);
    const a = t.attachments[0]!;
    expect(a.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(a.content).toMatchObject({ type: 'AdaptiveCard', version: '1.4' });
    expect(a.content.body[0]).toMatchObject({ type: 'TextBlock', text: m.title });
    expect(a.content.actions[0]).toMatchObject({ type: 'Action.OpenUrl', url: 'https://po.example.com/records/rec-1' });
  });
});
