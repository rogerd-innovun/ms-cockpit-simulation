import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { statusTone, toneClass } from '../lib/status';
import type { POStatus, WorklistRow } from '../lib/types';

/** FR-12.4 — the views people actually work from. */
const VIEWS: { key: string; label: string; tone: string; statuses?: POStatus[]; mine?: boolean }[] = [
  { key: 'all', label: 'All', tone: 't-idle' },
  { key: 'review', label: 'Needs review', tone: 't-warn', statuses: ['NEEDS_REVIEW'] },
  { key: 'failed', label: 'Failed', tone: 't-crit', statuses: ['FAILED', 'EXTRACTION_FAILED'] },
  { key: 'inflight', label: 'In flight', tone: 't-info', statuses: ['APPROVED', 'SENT_TO_SAP'] },
  { key: 'draft', label: 'Incoming', tone: 't-info', statuses: ['DRAFT', 'PUBLISHED', 'PROCESSING'] },
  { key: 'done', label: 'SO created', tone: 't-ok', statuses: ['SO_CREATED'] },
  { key: 'mine', label: 'Mine', tone: 't-idle', mine: true },
];

type SortKey = 'status' | 'poNumber' | 'customer' | 'lines' | 'value' | 'soNumber' | 'age';

const num = (s?: string | null) => {
  const n = Number.parseFloat((s ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : -Infinity;
};

const keyOf = (r: WorklistRow, k: SortKey): string | number => {
  switch (k) {
    case 'status': return r.status;
    case 'poNumber': return r.header?.poNumber ?? '';
    case 'customer': return r.header?.customerName ?? '';
    case 'lines': return r.header?._count.lineItems ?? 0;
    case 'value': return num(r.header?.poTotalValue);
    case 'soNumber': return r.soNumber ?? '';
    case 'age': return new Date(r.statusChangedAt).getTime();
  }
};

export function WorklistPage() {
  const [view, setView] = useState('all');
  const [q, setQ] = useState('');
  // The query fires on the debounced value, not per keystroke.
  const [debouncedQ, setDebouncedQ] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'age', dir: -1 });
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const active = VIEWS.find((v) => v.key === view)!;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const list = useQuery({
    queryKey: ['records', view, debouncedQ],
    queryFn: () =>
      api.list({ status: active.statuses?.join(','), mine: active.mine, q: debouncedQ || undefined }),
    // FR-12.7 — statuses move on their own, so the list refreshes itself.
    refetchInterval: 4000,
  });

  const counts = useQuery({ queryKey: ['counts'], queryFn: api.counts, refetchInterval: 4000 });

  const upload = useMutation({
    mutationFn: (file: File) => api.upload(file),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['records'] });
      navigate(`/records/${res.record.id}`);
    },
    onError: (err) => setUploadError(err instanceof ApiError ? err.message : 'Upload failed.'),
  });

  // "/" puts the cursor in search from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const total = counts.data ? Object.values(counts.data).reduce((a, b) => a + b, 0) : null;
  const countFor = (v: (typeof VIEWS)[number]) => {
    if (!counts.data) return null;
    if (v.key === 'all') return total;
    if (!v.statuses) return null;
    return v.statuses.reduce((sum, s) => sum + (counts.data![s] ?? 0), 0);
  };

  const rows = useMemo(() => {
    const r = [...(list.data?.rows ?? [])];
    r.sort((a, b) => {
      const x = keyOf(a, sort.key);
      const y = keyOf(b, sort.key);
      if (x === y) return 0;
      return (x > y ? 1 : -1) * sort.dir;
    });
    return r;
  }, [list.data, sort]);

  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 } : { key, dir: 1 }));

  const sortProps = (key: SortKey, label: string, cls?: string) => (
    <th
      className={`sortable ${cls ?? ''}`}
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
      onClick={() => onSort(key)}
      title={`Sort by ${label.toLowerCase()}`}
    >
      {label}
      <span className="dir" aria-hidden="true">{sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : '·'}</span>
    </th>
  );

  const takeFile = (file?: File | null) => {
    setUploadError(null);
    if (!file) return;
    // Some sources drop files with an empty MIME type; the server validates the
    // actual content, so only refuse a file that positively claims to be something else.
    if (file.type && file.type !== 'application/pdf') {
      setUploadError(`${file.name} is not a PDF.`);
      return;
    }
    upload.mutate(file);
  };

  /** FR-12.6 — export exactly what is on screen: current view, search and sort. */
  const exportCsv = () => {
    const esc = (v: string | null | undefined) => {
      const s = (v ?? '').replace(/\r?\n/g, ' ');
      return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      'Status,PO number,Customer,Customer code,Lines,Value,Currency,SO number,Uploaded by,File,Correlation id,Status changed',
      ...rows.map((r) =>
        [
          r.status,
          r.header?.poNumber,
          r.header?.customerName,
          r.header?.customerCode,
          String(r.header?._count.lineItems ?? 0),
          r.header?.poTotalValue,
          r.header?.currency,
          r.soNumber,
          r.uploadedBy.name,
          r.sourceDocument?.originalFilename,
          r.correlationId,
          r.statusChangedAt,
        ]
          .map(esc)
          .join(','),
      ),
    ];
    // The BOM makes Excel read the file as UTF-8 instead of the local codepage.
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `worklist-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div
      className={`dropzone ${over ? 'over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); takeFile(e.dataTransfer.files?.[0]); }}
    >
      <div className="sheet">
        <div className="head">
          <div className="head-row">
            <div>
              <h1>Purchase orders</h1>
              <p className="cap">
                Drop a PDF anywhere on this page, or press <kbd>/</kbd> to search.
              </p>
            </div>
            <div className="spacer" />
            <div className="actions">
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf"
                hidden
                onChange={(e) => { takeFile(e.target.files?.[0]); e.target.value = ''; }}
              />
              <button
                className="quiet sm"
                onClick={exportCsv}
                disabled={!rows.length}
                title="Download the current view as CSV"
              >
                Export CSV
              </button>
              <button className="primary" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
                {upload.isPending ? 'Uploading…' : 'Upload PO PDF'}
              </button>
            </div>
          </div>
        </div>

        {uploadError && <div className="err" role="alert">{uploadError}</div>}

        <div className="tabrule" role="group" aria-label="Filter by state">
          {VIEWS.map((v) => {
            const n = countFor(v);
            return (
              <button
                key={v.key}
                className={`tab ${v.tone}`}
                aria-pressed={view === v.key}
                onClick={() => setView(v.key)}
              >
                {v.statuses && <span className="lamp" aria-hidden="true" />}
                {v.label}
                {n != null && <span className="n">{n}</span>}
              </button>
            );
          })}
          <div className="spacer" />
          <div className="search" style={{ margin: '4px 0 6px' }}>
            <span className="faint" aria-hidden="true">⌕</span>
            <input
              ref={searchRef}
              type="search"
              placeholder="PO number, customer, SO number, correlation id"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search records"
            />
          </div>
        </div>

        {list.isLoading ? (
          <div className="empty">Loading…</div>
        ) : list.isError ? (
          <div className="err" role="alert">
            The worklist could not be loaded. It will retry on its own; check the health
            indicator above if this persists.
          </div>
        ) : !rows.length ? (
          <div className="empty">
            {q ? `Nothing matches “${q}”.` : 'Nothing here yet. Drop a PO PDF to get started.'}
          </div>
        ) : (
          <div className="ledger-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  {sortProps('status', 'State')}
                  {sortProps('poNumber', 'PO number')}
                  {sortProps('customer', 'Customer')}
                  {sortProps('lines', 'Lines', 'num')}
                  {sortProps('value', 'Value', 'num')}
                  {sortProps('soNumber', 'SO number')}
                  <th>Uploaded by</th>
                  <th>Correlation id</th>
                  {sortProps('age', 'Age', 'num')}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const wants = r.status === 'NEEDS_REVIEW' || r.status === 'FAILED' || r.status === 'EXTRACTION_FAILED';
                  return (
                    <tr
                      key={r.id}
                      className={`${wants ? 'flagged' : ''} ${toneClass(statusTone(r.status))}`}
                      tabIndex={0}
                      onClick={() => navigate(`/records/${r.id}`)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/records/${r.id}`); }
                      }}
                    >
                      <td>
                        <StatusBadge status={r.status} />
                        {r.currentAttempt > 1 && <span className="sub mono">attempt {r.currentAttempt}</span>}
                      </td>
                      <td style={{ fontWeight: 500 }}>{r.header?.poNumber ?? <span className="faint">—</span>}</td>
                      <td>
                        {r.header?.customerName ?? <span className="faint">—</span>}
                        {r.header?.customerCode && <span className="sub mono">{r.header.customerCode}</span>}
                      </td>
                      <td className="num tnum">{r.header?._count.lineItems ?? 0}</td>
                      <td className="num tnum">
                        {r.header?.poTotalValue ? (
                          <>{r.header.poTotalValue} <span className="faint">{r.header.currency ?? ''}</span></>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td className="mono">{r.soNumber ?? <span className="faint">—</span>}</td>
                      <td className="muted">{r.uploadedBy.name}</td>
                      <td className="mono faint" title={r.correlationId}>{r.correlationId.slice(0, 11)}…</td>
                      <td className="num muted tnum">{age(r.statusChangedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="cap" style={{ marginTop: 10 }}>
          {list.data ? `${list.data.total} record${list.data.total === 1 ? '' : 's'}` : ''}
        </p>
      </div>
    </div>
  );
}

function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
