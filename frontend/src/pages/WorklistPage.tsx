import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { MAX_BATCH, summarise, uploadAndPublishAll, type BatchOutcome } from '../lib/batchUpload';
import { parseDecimal } from '../lib/decimal';
import { ago } from '../lib/format';
import { readWorklist, rememberWorklist, writeWorklist, type SortKey, type WorklistState } from '../lib/worklistState';
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

// Read the way the validator reads amounts, so "1.245,00" sorts as 1245 and not 124500.
const num = (s?: string | null) => parseDecimal(s) ?? -Infinity;

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

/** Rows fetched per page; the server caps a page at 200. */
const PAGE_SIZE = 50;

export function WorklistPage() {
  // The view, the search and the sort live in the URL, so opening a record and coming back
  // (Back, the Worklist link, a reload) lands on the same list.
  const [params, setParams] = useSearchParams();
  const { view, q: urlQ, sort } = readWorklist(params, VIEWS.map((v) => v.key));
  const update = (patch: Partial<WorklistState>) =>
    setParams((prev) => writeWorklist({ ...readWorklist(prev, VIEWS.map((v) => v.key)), ...patch }), { replace: true });
  // What is typed shows at once; the URL, and so the query, follows 300 ms after the last key.
  const [q, setQ] = useState(urlQ);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // A multi-file drop: progress while it runs, then what happened to each file.
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<BatchOutcome[] | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const active = VIEWS.find((v) => v.key === view)!;

  useEffect(() => {
    if (q === urlQ) return;
    const t = setTimeout(() => update({ q }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // Back / forward (or a pasted link) changes the URL under the search box.
  useEffect(() => setQ(urlQ), [urlQ]);

  // Remembered so the Worklist link on a record page can return to this list.
  useEffect(() => rememberWorklist(params.toString()), [params]);

  const filters = { status: active.statuses?.join(','), mine: active.mine, q: urlQ || undefined };

  // The list is paged: the footer says how much of it is on screen, and "Show more"
  // fetches the rest. It used to fetch one page and say nothing, so with more than 50
  // records the older ones were simply unreachable except by searching for them.
  const list = useInfiniteQuery({
    queryKey: ['records', view, urlQ],
    queryFn: ({ pageParam }) => api.list({ ...filters, take: PAGE_SIZE, skip: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.rows.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    // FR-12.7 — statuses move on their own, so the list refreshes itself.
    refetchInterval: 4000,
  });

  // A record moving between pages mid-refresh can appear on two of them; show it once.
  const loaded = useMemo(() => {
    const seen = new Set<string>();
    const out: WorklistRow[] = [];
    for (const page of list.data?.pages ?? []) {
      for (const row of page.rows) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          out.push(row);
        }
      }
    }
    return out;
  }, [list.data]);
  const matching = list.data ? list.data.pages[list.data.pages.length - 1]!.total : 0;

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

  const sortRows = (input: WorklistRow[]) =>
    [...input].sort((a, b) => {
      const x = keyOf(a, sort.key);
      const y = keyOf(b, sort.key);
      if (x === y) return 0;
      return (x > y ? 1 : -1) * sort.dir;
    });
  const rows = useMemo(() => sortRows(loaded), [loaded, sort]);

  const onSort = (key: SortKey) =>
    update({ sort: sort.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: 1 } });

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

  const busy = upload.isPending || batch !== null;

  /**
   * One file opens its draft, so it can be checked before it is published. Several are each
   * made into their own record and sent straight for extraction (FR-1.7): checking a dozen
   * drafts one by one is the thing a batch is for avoiding, and anything that needs a
   * person's eye (a repeat of an earlier file, a failed publish) is left as a draft and
   * listed in the report.
   */
  const takeFiles = async (files: File[]) => {
    setUploadError(null);
    setReport(null);
    if (files.length === 0) return;
    if (busy) {
      setUploadError('An upload is still running. Add more when it has finished.');
      return;
    }
    if (files.length === 1) {
      const file = files[0]!;
      // Some sources drop files with an empty MIME type; the server validates the
      // actual content, so only refuse a file that positively claims to be something else.
      if (file.type && file.type !== 'application/pdf') {
        setUploadError(`${file.name} is not a PDF.`);
        return;
      }
      upload.mutate(file);
      return;
    }
    setBatch({ done: 0, total: files.length });
    try {
      setReport(
        await uploadAndPublishAll(files, api, { onProgress: (done, total) => setBatch({ done, total }) }),
      );
    } finally {
      setBatch(null);
      qc.invalidateQueries({ queryKey: ['records'] });
      qc.invalidateQueries({ queryKey: ['counts'] });
    }
  };

  /**
   * FR-12.6 — export the current view, search and sort. "The current view" is every record
   * that matches, not just the pages loaded so far: exporting the visible 50 of 57 would
   * hand over a file that looks complete and is not.
   */
  const exportCsv = async () => {
    setExportError(null);
    setExporting(true);
    let all: WorklistRow[];
    try {
      all = [];
      for (;;) {
        const page = await api.list({ ...filters, take: 200, skip: all.length });
        all.push(...page.rows);
        if (!page.rows.length || all.length >= page.total) break;
      }
    } catch (err) {
      setExportError(err instanceof ApiError ? err.message : 'The export could not be fetched.');
      return;
    } finally {
      setExporting(false);
    }
    const esc = (v: string | null | undefined) => {
      const s = (v ?? '').replace(/\r?\n/g, ' ');
      return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      'Status,PO number,Customer,Customer code,Lines,Value,Currency,SO number,Uploaded by,File,Correlation id,Status changed',
      ...sortRows(all).map((r) =>
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
      onDrop={(e) => { e.preventDefault(); setOver(false); void takeFiles(Array.from(e.dataTransfer.files ?? [])); }}
    >
      <div className="sheet">
        <div className="head">
          <div className="head-row">
            <div>
              <h1>Purchase orders</h1>
              <p className="cap">
                Drop PDFs anywhere on this page &mdash; up to {MAX_BATCH} at once &mdash; or press <kbd>/</kbd> to search.
              </p>
            </div>
            <div className="spacer" />
            <div className="actions">
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf"
                multiple
                hidden
                // Copied out before the value is cleared: the FileList is live and empties with it.
                onChange={(e) => { const picked = Array.from(e.target.files ?? []); e.target.value = ''; void takeFiles(picked); }}
              />
              <button
                className="quiet sm"
                onClick={exportCsv}
                disabled={!rows.length || exporting}
                title="Download every record in the current view as CSV"
              >
                {exporting ? 'Exporting…' : 'Export CSV'}
              </button>
              <button className="primary" onClick={() => fileRef.current?.click()} disabled={busy}>
                {batch ? `Uploading ${batch.done} of ${batch.total}…` : upload.isPending ? 'Uploading…' : 'Upload PO PDFs'}
              </button>
            </div>
          </div>
        </div>

        {uploadError && <div className="err" role="alert">{uploadError}</div>}
        {report && <BatchReport outcomes={report} onDismiss={() => setReport(null)} />}
        {exportError && <div className="err" role="alert">{exportError}</div>}

        <div className="tabrule" role="group" aria-label="Filter by state">
          <div className="tabs">
            {VIEWS.map((v) => {
              const n = countFor(v);
              return (
                <button
                  key={v.key}
                  className={`tab ${v.tone}`}
                  aria-pressed={view === v.key}
                  onClick={() => update({ view: v.key })}
                >
                  {v.statuses && <span className="lamp" aria-hidden="true" />}
                  {v.label}
                  {n != null && <span className="n">{n}</span>}
                </button>
              );
            })}
          </div>
          <div className="spacer" />
          <div className="search">
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
            {q ? `Nothing matches “${q}”.` : 'Nothing here yet. Drop one or more PO PDFs to get started.'}
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
                      <td className="num muted tnum">{ago(r.statusChangedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="cap" style={{ marginTop: 10 }}>
          {list.data &&
            (list.hasNextPage
              ? `Showing ${rows.length} of ${matching} records`
              : `${matching} record${matching === 1 ? '' : 's'}`)}
          {list.hasNextPage && (
            <>
              {' · '}
              <button
                className="quiet sm"
                onClick={() => list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {list.isFetchingNextPage ? 'Loading…' : `Show ${Math.min(PAGE_SIZE, matching - rows.length)} more`}
              </button>
              {(sort.key !== 'age' || sort.dir !== -1) && ' · sorted within the records shown'}
            </>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * What became of each file in a multi-file drop. The ones that went smoothly are a count;
 * anything that needs a person is named, with the reason and a way to open it.
 */
function BatchReport({ outcomes, onDismiss }: { outcomes: BatchOutcome[]; onDismiss: () => void }) {
  const s = summarise(outcomes);
  const attention = outcomes.filter((o) => o.kind !== 'queued');
  const parts = [
    s.queued > 0 && `${s.queued} sent for extraction`,
    s.draft > 0 && `${s.draft} left as ${s.draft === 1 ? 'a draft' : 'drafts'}`,
    s.skipped > 0 && `${s.skipped} skipped`,
    s.failed > 0 && `${s.failed} could not be uploaded`,
  ].filter(Boolean);
  return (
    <div className={`notice ${attention.length > 0 ? 't-warn' : 't-ok'}`} role="status" style={{ marginTop: 12 }}>
      <b>{outcomes.length} files: {parts.join(' · ')}</b>
      {s.queued > 0 && (
        <span>
          They are being read now, one after another, and will appear under Needs review as each finishes.
          Nothing goes to SAP until someone approves it.
        </span>
      )}
      {attention.map((o, i) => (
        <span key={`${o.file}-${i}`}>
          <b>{o.file}</b> &mdash; {o.kind === 'draft' || o.kind === 'skipped' || o.kind === 'failed' ? o.reason : ''}
          {o.kind === 'draft' && (
            <>
              {' '}
              <Link to={`/records/${o.recordId}`}>Open</Link>
            </>
          )}
        </span>
      ))}
      <div>
        <button className="quiet sm" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}
