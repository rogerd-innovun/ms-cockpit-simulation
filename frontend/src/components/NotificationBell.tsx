import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { KIND_TONE } from '../lib/notifications';
import type { NotificationItem } from '../lib/types';

/**
 * FR-14 — the in-app channel: a bell with the number of things that arrived since you last
 * looked. Opening it shows what they are without marking anything read; "Mark all read" is
 * a deliberate act, so a glance never makes a notice disappear.
 */
export function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);

  const inbox = useQuery({ queryKey: ['notifications', 12], queryFn: () => api.notifications(12), refetchInterval: 15_000 });
  const markRead = useMutation({
    mutationFn: () => api.markNotificationsRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (host.current && !host.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const unread = inbox.data?.unread ?? 0;

  return (
    <div className="bell" ref={host}>
      <button
        className="quiet sm bell-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={unread > 0 ? `Notifications, ${unread} new` : 'Notifications'}
        title="Notifications"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread > 0 && <span className="bell-n tnum">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <div className="bell-head">
            <b>Notifications</b>
            <div className="spacer" />
            <button className="quiet sm" disabled={unread === 0 || markRead.isPending} onClick={() => markRead.mutate()}>
              Mark all read
            </button>
          </div>
          {inbox.isLoading ? (
            <p className="bell-empty">Loading…</p>
          ) : (inbox.data?.items.length ?? 0) === 0 ? (
            <p className="bell-empty">Nothing yet. A note appears here when a PO needs you or something changes on one of yours.</p>
          ) : (
            <ul className="bell-list">
              {inbox.data!.items.map((n) => (
                <li key={n.id}>
                  <NotificationRow n={n} onNavigate={() => setOpen(false)} />
                </li>
              ))}
            </ul>
          )}
          <div className="bell-foot">
            <Link to="/notifications" onClick={() => setOpen(false)}>All notifications &amp; settings</Link>
          </div>
        </div>
      )}
    </div>
  );
}

export function NotificationRow({ n, onNavigate }: { n: NotificationItem; onNavigate?: () => void }) {
  const inner = (
    <>
      <span className="lamp" aria-hidden="true" />
      <span className="n-main">
        <span className="n-title">{n.title}</span>
        {n.body && <span className="n-body">{n.body}</span>}
      </span>
      <time className="n-time cap" dateTime={n.createdAt} title={new Date(n.createdAt).toLocaleString()}>
        {ago(n.createdAt)}
      </time>
    </>
  );
  const cls = `n-row ${KIND_TONE[n.kind]} ${n.unread ? 'unread' : ''}`;
  return n.recordId ? (
    <Link to={`/records/${n.recordId}`} className={cls} onClick={onNavigate}>{inner}</Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}
