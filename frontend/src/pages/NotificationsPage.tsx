import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NotificationRow } from '../components/NotificationBell';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { ChannelStats, NotificationKind } from '../lib/types';

/** FR-14.4 — which notifications reach you and where, who else they reach, and what the channels are doing. */
export function NotificationsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [testNote, setTestNote] = useState<string | null>(null);

  const prefs = useQuery({ queryKey: ['notification-prefs'], queryFn: api.notificationPrefs });
  const channels = useQuery({ queryKey: ['notification-channels'], queryFn: api.notificationChannels, refetchInterval: 15_000 });
  const inbox = useQuery({ queryKey: ['notifications', 100], queryFn: () => api.notifications(100), refetchInterval: 15_000 });

  const save = useMutation({
    mutationFn: (v: { kind: NotificationKind; inApp?: boolean; email?: boolean }) => {
      const { kind, ...change } = v;
      return api.setNotificationPref(kind, change);
    },
    onSuccess: (data) => {
      qc.setQueryData(['notification-prefs'], data);
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const markRead = useMutation({
    mutationFn: () => api.markNotificationsRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const test = useMutation({
    mutationFn: () => api.sendTestNotification(),
    onSuccess: (r) => {
      setTestNote(
        r.email || r.teams
          ? `Sent. It reaches you in the app straight away and by ${[r.email && 'email', r.teams && 'Teams'].filter(Boolean).join(' and ')} within a few seconds.`
          : 'Sent to your inbox here. No email or Teams channel is set up on this server, so nothing else went out.',
      );
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['notification-channels'] });
    },
    onError: (err) => setTestNote(err instanceof ApiError ? err.message : 'The test could not be sent.'),
  });

  const ch = channels.data;
  const emailOn = ch?.email.configured ?? false;

  return (
    <div className="sheet">
      <div className="head">
        <h1>Notifications</h1>
        <p className="cap">Tell me when a PO needs me, so nobody has to watch the worklist.</p>
      </div>

      <section className="sec">
        <div className="sec-head"><h2>What reaches you</h2></div>
        {prefs.isLoading ? (
          <p className="cap">Loading…</p>
        ) : (
          <table className="prefs">
            <thead>
              <tr>
                <th>Notification</th>
                <th className="c">In the app</th>
                <th className="c" title={emailOn ? undefined : 'Email is not set up on this server'}>Email</th>
              </tr>
            </thead>
            <tbody>
              {prefs.data?.preferences.map((p) => (
                <tr key={p.kind}>
                  <td>
                    <b>{p.label}</b>
                    <span className="sub">{p.description}</span>
                  </td>
                  <td className="c">
                    <input
                      type="checkbox"
                      checked={p.inApp}
                      disabled={save.isPending}
                      aria-label={`${p.label}: in the app`}
                      onChange={(e) => save.mutate({ kind: p.kind, inApp: e.target.checked })}
                    />
                  </td>
                  <td className="c">
                    <input
                      type="checkbox"
                      checked={p.email && emailOn}
                      disabled={save.isPending || !emailOn}
                      aria-label={`${p.label}: by email`}
                      onChange={(e) => save.mutate({ kind: p.kind, email: e.target.checked })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {ch && !emailOn && <p className="cap" style={{ marginTop: 8 }}>Email is not set up on this server, so only the in-app column does anything.</p>}
      </section>

      <section className="sec">
        <div className="sec-head"><h2>Channels</h2></div>
        {ch ? (
          <ul className="stat-list">
            <li>
              <span className={`lamp ${emailOn ? 't-ok' : 't-idle'}`} aria-hidden="true" />
              <span>Email</span>
              <span className="spacer" />
              <span className="cap">
                {emailOn ? (ch.email.redirected ? 'on — every email goes to one address (demo mode)' : 'on') : 'not set up'}
              </span>
            </li>
            <li>
              <span className={`lamp ${ch.teams.configured ? 't-ok' : 't-idle'}`} aria-hidden="true" />
              <span>Microsoft Teams channel</span>
              <span className="spacer" />
              <span className="cap">
                {ch.teams.configured ? (ch.teams.kinds.length ? `on — ${ch.teams.kinds.length} kinds` : 'on — all kinds') : 'not set up'}
              </span>
            </li>
          </ul>
        ) : (
          <p className="cap">Loading…</p>
        )}

        {ch?.recent && (
          <>
            <p className="cap" style={{ margin: '14px 0 4px' }}>Last 24 hours</p>
            <ul className="stat-list">
              <Delivery label="Email" stats={ch.recent.email} />
              <Delivery label="Teams" stats={ch.recent.teams} />
            </ul>
          </>
        )}

        {user?.role === 'ADMIN' && (
          <div style={{ marginTop: 14 }}>
            <button onClick={() => test.mutate()} disabled={test.isPending}>
              {test.isPending ? 'Sending…' : 'Send me a test notification'}
            </button>
            {testNote && <p className="cap" style={{ marginTop: 8 }} role="status">{testNote}</p>}
          </div>
        )}
      </section>

      <section className="sec">
        <div className="sec-head">
          <h2>Recent</h2>
          <span className="count-chip tnum">{inbox.data?.items.length ?? 0}</span>
          <div className="spacer" />
          <button className="quiet sm" disabled={!inbox.data?.unread || markRead.isPending} onClick={() => markRead.mutate()}>
            Mark all read
          </button>
        </div>
        {(inbox.data?.items.length ?? 0) === 0 ? (
          <p className="cap">Nothing yet.</p>
        ) : (
          <ul className="bell-list full">
            {inbox.data!.items.map((n) => (
              <li key={n.id}><NotificationRow n={n} /></li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Delivery({ label, stats }: { label: string; stats: ChannelStats }) {
  return (
    <li>
      <span>{label}</span>
      <span className="spacer" />
      <span className="cap tnum">
        {stats.sent} sent · {stats.pending} waiting · {stats.failed} gave up
      </span>
      {stats.lastError && <span className="cap err-inline" title={stats.lastError}>last error: {stats.lastError.slice(0, 80)}</span>}
    </li>
  );
}
