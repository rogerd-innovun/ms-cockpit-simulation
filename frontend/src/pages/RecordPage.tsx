import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Field } from '../components/Field';
import { LineItemsTable } from '../components/LineItemsTable';
import { PdfPane } from '../components/PdfPane';
import { StatusBadge } from '../components/StatusBadge';
import { LifecycleRail } from '../components/LifecycleRail';
import type { FieldProvenance, RecordDetail } from '../lib/types';

const HEADER_LAYOUT: { key: string; label: string; full?: boolean }[] = [
  { key: 'poNumber', label: 'PO number' },
  { key: 'poDate', label: 'PO date' },
  { key: 'customerName', label: 'Customer name' },
  { key: 'customerCode', label: 'Customer code' },
  { key: 'currency', label: 'Currency' },
  { key: 'poTotalValue', label: 'PO total value' },
  { key: 'requestedDeliveryDate', label: 'Requested delivery' },
  { key: 'paymentTerms', label: 'Payment terms' },
  { key: 'incoterms', label: 'Incoterms' },
  { key: 'contact', label: 'Contact' },
  { key: 'shipTo', label: 'Ship-to', full: true },
  { key: 'billTo', label: 'Bill-to', full: true },
];

export function RecordPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [showReject, setShowReject] = useState(false);
  // FR-3.4 — publishing a duplicate is allowed with a stated reason; this is that flow.
  const [overrideReason, setOverrideReason] = useState('');
  const [showOverride, setShowOverride] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const [showKeys, setShowKeys] = useState(false);
  const [split, setSplit] = useState(42);
  const splitRef = useRef<HTMLDivElement>(null);

  const detail = useQuery({
    queryKey: ['record', id],
    queryFn: () => api.detail(id),
    refetchInterval: (q) => {
      const s = (q.state.data as RecordDetail | undefined)?.record.status;
      return s && ['PUBLISHED', 'PROCESSING', 'APPROVED', 'SENT_TO_SAP'].includes(s) ? 2000 : false;
    },
  });

  const mutate = useMutation({
    mutationFn: (op: () => Promise<RecordDetail>) => op(),
    onMutate: () => setActionError(null),
    onSuccess: (data) => {
      qc.setQueryData(['record', id], data);
      qc.invalidateQueries({ queryKey: ['records'] });
      qc.invalidateQueries({ queryKey: ['counts'] });
      setShowOverride(false);
      setOverrideReason('');
    },
    onError: (err) => {
      setActionError(err instanceof ApiError ? err.message : 'That action could not be completed.');
      if (err instanceof ApiError && err.code === 'DUPLICATE_DOCUMENT') setShowOverride(true);
    },
  });

  const d = detail.data;

  const fieldMap = useMemo(() => {
    const m = new Map<string, FieldProvenance>();
    for (const f of d?.fields ?? []) m.set(f.fieldPath, f);
    return m;
  }, [d]);

  /** The walk: every header field a person still has to look at, in reading order. */
  const walk = useMemo(() => {
    if (!d) return [] as string[];
    const issuePaths = new Set(
      d.validation.issues.filter((i) => i.severity === 'BLOCKING' || !i.acknowledged).map((i) => i.fieldPath),
    );
    return HEADER_LAYOUT.map((f) => `header.${f.key}`).filter((p) => {
      const pr = fieldMap.get(p);
      return issuePaths.has(p) || (pr?.lowConfidence && !pr.editedAt);
    });
  }, [d, fieldMap]);

  const moveTo = useCallback(
    (idx: number) => {
      if (!walk.length) return;
      const next = ((idx % walk.length) + walk.length) % walk.length;
      setCursor(next);
      document
        .querySelector(`[data-fieldpath="${walk[next]}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
    [walk],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (e.key === 'Escape' && typing) { (el as HTMLElement).blur(); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'j') { e.preventDefault(); moveTo(cursor + 1); }
      else if (e.key === 'k') { e.preventDefault(); moveTo(cursor - 1); }
      else if (e.key === '?') { e.preventDefault(); setShowKeys((s) => !s); }
      else if (e.key === 'Enter' && cursor >= 0) {
        e.preventDefault();
        (document.getElementById(walk[cursor]!) as HTMLInputElement | null)?.focus();
      } else if (e.key === 'a' && cursor >= 0 && d) {
        const path = walk[cursor]!;
        const w = d.validation.issues.find(
          (i) => i.fieldPath === path && i.severity === 'WARNING' && !i.acknowledged,
        );
        if (w) { e.preventDefault(); mutate.mutate(() => api.acknowledge(id, w.code, w.fieldPath)); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cursor, walk, d, id, moveTo, mutate]);

  // Drag the rule between the document and the reading.
  //
  // Window listeners rather than setPointerCapture: the cursor outruns a 7px
  // handle immediately, and capture is the part that breaks first (it is absent
  // under synthetic input and flaky across engines). Listening on the window for
  // the duration of the drag works everywhere, and pointercancel ends it cleanly
  // if the browser takes the pointer away mid-gesture.
  const setFromX = useCallback((clientX: number) => {
    const host = splitRef.current;
    if (!host) return;
    const box = host.getBoundingClientRect();
    setSplit(Math.min(70, Math.max(24, ((clientX - box.left) / box.width) * 100)));
  }, []);

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const move = (ev: PointerEvent) => setFromX(ev.clientX);
      const stop = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
      // hold the resize cursor and kill text selection for the whole gesture
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [setFromX],
  );

  if (detail.isLoading) return <div className="empty">Loading record…</div>;
  if (detail.isError || !d) return <div className="empty">Record not found.</div>;

  const r = d.record;
  const threshold = d.validation.threshold;
  const editable = r.status === 'NEEDS_REVIEW' || r.status === 'EXTRACTION_FAILED';
  const canApprove = user?.role === 'APPROVER' || user?.role === 'ADMIN';
  const isOwnUpload = r.uploadedBy.id === user?.id;

  const lowCount = d.fields.filter((f) => f.lowConfidence && !f.editedAt).length;
  const blocking = d.validation.issues.filter((i) => i.severity === 'BLOCKING');
  const warnings = d.validation.issues.filter((i) => i.severity === 'WARNING');
  const busy = mutate.isPending;

  const headerField = (f: { key: string; label: string }) => (
    <Field
      key={f.key}
      label={f.label}
      fieldPath={`header.${f.key}`}
      value={(r.header as unknown as Record<string, string | null>)[f.key] ?? null}
      provenance={fieldMap.get(`header.${f.key}`)}
      issues={d.validation.issues}
      threshold={threshold}
      disabled={!editable || busy}
      cursor={walk[cursor] === `header.${f.key}`}
      onCommit={(v) => mutate.mutate(() => api.updateFields(id, { header: { [f.key]: v } }))}
    />
  );

  return (
    <div className="sheet">
      <div className="rec-head">
        <div style={{ minWidth: 0 }}>
          <div className="rec-meta">
            <Link to="/">Worklist</Link>
            <StatusBadge status={r.status} />
            {r.currentAttempt > 0 && <span className="cap">attempt {r.currentAttempt}</span>}
            {r.vendorProfile ? (
              <span className="cap" title="A vendor-specific extraction prompt was used">
                {r.vendorProfile.name} v{r.vendorProfile.version}
              </span>
            ) : r.header ? (
              <span className="cap" title="No vendor profile matched; the generic prompt was used">
                generic extraction
              </span>
            ) : null}
          </div>
          <div className="rec-title">
            {r.header?.poNumber ?? r.sourceDocument?.originalFilename ?? 'Purchase order'}
          </div>
          <div className="rec-corr">{r.correlationId}</div>
        </div>
        <div className="spacer" />
        <Actions
          d={d}
          busy={busy}
          canApprove={canApprove}
          isOwnUpload={isOwnUpload}
          onAction={(op) => mutate.mutate(op)}
          onReject={() => setShowReject((s) => !s)}
          onDeleted={() => navigate('/')}
        />
      </div>

      <LifecycleRail status={r.status} />

      {actionError && <div className="err" role="alert">{actionError}</div>}

      {showOverride && r.status === 'DRAFT' && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginTop: 14, maxWidth: 560 }}>
          <div className="fieldrow" style={{ gridTemplateColumns: '1fr', flex: 1 }}>
            <div className="body">
              <label htmlFor="override-reason">Why publish it anyway? Goes in the audit trail.</label>
              <input
                id="override-reason"
                autoFocus
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="e.g. the earlier record was a test run"
              />
            </div>
          </div>
          <button
            className="primary"
            disabled={!overrideReason.trim() || busy}
            onClick={() => mutate.mutate(() => api.publish(id, overrideReason.trim()))}
          >
            Publish anyway
          </button>
        </div>
      )}

      {showReject && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginTop: 14, maxWidth: 560 }}>
          <div className="fieldrow" style={{ gridTemplateColumns: '1fr', flex: 1 }}>
            <div className="body">
              <label htmlFor="reject-reason">Reason for sending back</label>
              <input
                id="reject-reason"
                autoFocus
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="What needs fixing?"
              />
            </div>
          </div>
          <button
            className="danger"
            disabled={!rejectReason.trim() || busy}
            onClick={() => {
              mutate.mutate(() => api.reject(id, rejectReason));
              setShowReject(false);
              setRejectReason('');
            }}
          >
            Send back
          </button>
        </div>
      )}

      <Notices d={d} />

      {r.status === 'DRAFT' ? (
        <DraftView d={d} />
      ) : r.header ? (
        <div className="split" ref={splitRef} style={{ ['--split' as string]: `${split}%` }}>
          {r.sourceDocument ? (
            <PdfPane recordId={r.id} filename={r.sourceDocument.originalFilename} />
          ) : (
            <div />
          )}

          <div
            className="split-handle"
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label="Resize the document pane"
            aria-valuenow={Math.round(split)}
            aria-valuemin={24}
            aria-valuemax={70}
            onPointerDown={startDrag}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') { e.preventDefault(); setSplit((s) => Math.max(24, s - 2)); }
              if (e.key === 'ArrowRight') { e.preventDefault(); setSplit((s) => Math.min(70, s + 2)); }
            }}
          />

          <div className="reading">
            <section className="sec" style={{ marginTop: 0 }}>
              <div className="sec-head">
                <h2>The reading</h2>
                <div className="spacer" />
                <span className="cap">
                  {blocking.length} blocking · {warnings.length} warning
                  {warnings.length === 1 ? '' : 's'} · {lowCount} below {Math.round(threshold * 100)}%
                </span>
              </div>

              {d.validation.issues.length > 0 && (
                <ul className="issues">
                  {[...blocking, ...warnings].slice(0, 10).map((i) => (
                    <li
                      key={`${i.code}-${i.fieldPath}`}
                      className={`${i.severity === 'BLOCKING' ? 't-crit' : 't-warn'} ${i.acknowledged ? 'done' : ''}`}
                    >
                      <span className="glyph" aria-hidden="true">{i.severity === 'BLOCKING' ? '✕' : '⚠'}</span>
                      <a href={`#${i.fieldPath}`}>{i.message}</a>
                      <div className="spacer" />
                      {i.severity === 'WARNING' && !i.acknowledged && editable && (
                        <button
                          className="sm"
                          disabled={busy}
                          onClick={() => mutate.mutate(() => api.acknowledge(id, i.code, i.fieldPath))}
                        >
                          Accept
                        </button>
                      )}
                      {i.acknowledged && <span className="cap">accepted</span>}
                    </li>
                  ))}
                </ul>
              )}

              <div className="fieldset" style={{ marginTop: 12 }}>
                {HEADER_LAYOUT.filter((f) => !f.full).map(headerField)}
              </div>
              <div className="fieldset wide">
                {HEADER_LAYOUT.filter((f) => f.full).map(headerField)}
              </div>
            </section>

            <LineItemsTable
              lines={r.header.lineItems}
              fields={fieldMap}
              issues={d.validation.issues}
              threshold={threshold}
              editable={editable && !busy}
              onEdit={(lineNumber, key, value) =>
                mutate.mutate(() => api.updateFields(id, { lines: [{ lineNumber, values: { [key]: value } }] }))
              }
              onAdd={() => mutate.mutate(() => api.addLine(id))}
              onDelete={(lineNumber) => mutate.mutate(() => api.deleteLine(id, lineNumber))}
            />

            <History d={d} />
          </div>
        </div>
      ) : (
        <div className="empty">
          {r.status === 'PROCESSING' || r.status === 'PUBLISHED'
            ? 'Extraction is running…'
            : 'No extracted data on this record.'}
        </div>
      )}

      {walk.length > 0 && (
        <button className="keys sm" onClick={() => setShowKeys((s) => !s)} aria-expanded={showKeys}>
          {walk.length} to check · <kbd>?</kbd>
        </button>
      )}
      {showKeys && (
        <div className="keysheet" role="dialog" aria-label="Keyboard shortcuts">
          <h3>Walking the flags</h3>
          <dl>
            <dt><kbd>J</kbd></dt><dd>next flagged field</dd>
            <dt><kbd>K</kbd></dt><dd>previous</dd>
            <dt><kbd>Enter</kbd></dt><dd>edit the marked field</dd>
            <dt><kbd>Esc</kbd></dt><dd>stop editing</dd>
            <dt><kbd>A</kbd></dt><dd>accept the warning on it</dd>
            <dt><kbd>?</kbd></dt><dd>hide this</dd>
          </dl>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- sub-views

function Actions({
  d, busy, canApprove, isOwnUpload, onAction, onReject, onDeleted,
}: {
  d: RecordDetail;
  busy: boolean;
  canApprove: boolean;
  isOwnUpload: boolean;
  onAction: (op: () => Promise<RecordDetail>) => void;
  onReject: () => void;
  onDeleted: () => void;
}) {
  const r = d.record;
  const id = r.id;
  const blocked = d.validation.blockingCount > 0;

  return (
    <div className="actions">
      {r.status === 'DRAFT' && (
        <>
          <button className="primary" disabled={busy} onClick={() => onAction(() => api.publish(id))}>
            Publish &amp; extract
          </button>
          <button className="quiet" disabled={busy} onClick={async () => { await api.deleteDraft(id); onDeleted(); }}>
            Delete
          </button>
        </>
      )}

      {r.status === 'EXTRACTION_FAILED' && (
        <>
          <button className="primary" disabled={busy} onClick={() => onAction(() => api.retryExtraction(id))}>
            Retry extraction
          </button>
          <button disabled={busy} onClick={() => onAction(() => api.manualEntry(id))}>Enter manually</button>
        </>
      )}

      {r.status === 'NEEDS_REVIEW' && (
        <>
          <button className="quiet" disabled={busy} onClick={onReject}>Send back</button>
          <button
            className="primary"
            disabled={busy || blocked || !canApprove || isOwnUpload}
            title={
              !canApprove
                ? 'Your role cannot approve records.'
                : isOwnUpload
                  ? 'Segregation of duties: this record must be approved by someone else.'
                  : blocked
                    ? `${d.validation.blockingCount} blocking issue(s) must be fixed first.`
                    : 'Approve and send to SAP'
            }
            onClick={() => onAction(() => api.approve(id))}
          >
            Approve &amp; send to SAP
          </button>
        </>
      )}

      {r.status === 'FAILED' && (
        <button className="primary" disabled={busy} onClick={() => onAction(() => api.resubmit(id))}>
          Correct &amp; resubmit
        </button>
      )}

      {['NEEDS_REVIEW', 'EXTRACTION_FAILED'].includes(r.status) && (
        <button className="quiet" disabled={busy} onClick={() => onAction(() => api.cancel(id))}>Cancel</button>
      )}
    </div>
  );
}

function Notices({ d }: { d: RecordDetail }) {
  const r = d.record;
  const any =
    r.status === 'SO_CREATED' ||
    (r.status === 'FAILED' && d.failure) ||
    r.status === 'EXTRACTION_FAILED' ||
    r.status === 'SENT_TO_SAP' ||
    d.duplicates.length > 0 ||
    (r.status === 'NEEDS_REVIEW' && (r.currentAttempt > 0 || r.failureCode));
  if (!any) return null;

  return (
    <div className="notice-stack">
      {r.status === 'SO_CREATED' && (
        <div className="notice t-ok">
          <b>Sales Order {r.soNumber} created in SAP</b>
          <span>The source PDF, the approved data and the full audit trail are retained.</span>
        </div>
      )}
      {r.status === 'FAILED' && d.failure && (
        <div className="notice t-crit">
          <b>SAP rejected this order — {d.failure.code}</b>
          <span>{d.failure.explanation}</span>
          <span><b>What to do:</b> {d.failure.remedy}</span>
          {r.failureMessage && <span className="raw">SAP said: {r.failureMessage}</span>}
        </div>
      )}
      {r.status === 'EXTRACTION_FAILED' && (
        <div className="notice t-crit">
          <b>Extraction could not complete</b>
          <span>Retry it, or enter the data by hand. Nothing has been sent to SAP.</span>
        </div>
      )}
      {r.status === 'SENT_TO_SAP' && (
        <div className="notice t-info">
          <b>Waiting for SAP</b>
          <span>The order file is in the drop folder. This page updates itself when a result comes back.</span>
        </div>
      )}
      {d.duplicates.length > 0 && (
        <div className="notice t-warn">
          <b>Possible duplicate</b>
          <span>
            {d.duplicates.length} other record{d.duplicates.length === 1 ? '' : 's'} share this PO number and customer:{' '}
            {d.duplicates.map((dup) => (
              <Link key={dup.recordId} to={`/records/${dup.recordId}`} style={{ marginRight: 8 }}>
                {dup.correlationId.slice(0, 11)}… ({dup.status})
              </Link>
            ))}
          </span>
        </div>
      )}
      {/* The failure that sent this record back stays on screen while it is being
          corrected — the reviewer needs the reason in front of them, not in the
          history. Covers both a SAP rejection after resubmit and a failed outbound
          write. Cleared on the next approval. */}
      {r.status === 'NEEDS_REVIEW' && r.failureCode && d.failure ? (
        <div className="notice t-warn">
          <b>Back for correction — {d.failure.code}</b>
          <span>{d.failure.explanation}</span>
          <span><b>What to do:</b> {d.failure.remedy}</span>
          {r.failureMessage && <span className="raw">SAP said: {r.failureMessage}</span>}
          {r.currentAttempt > 0 && (
            <span>
              Approving again submits attempt {r.currentAttempt + 1} under the same correlation id, so
              an earlier result cannot be mistaken for this one.
            </span>
          )}
        </div>
      ) : r.status === 'NEEDS_REVIEW' && r.currentAttempt > 0 ? (
        <div className="notice t-info">
          <b>Corrected after a SAP rejection</b>
          <span>
            Approving again submits attempt {r.currentAttempt + 1} under the same correlation id, so an
            earlier result cannot be mistaken for this one.
          </span>
        </div>
      ) : null}
    </div>
  );
}

function DraftView({ d }: { d: RecordDetail }) {
  const r = d.record;
  return (
    <div className="split" style={{ ['--split' as string]: '42%' }}>
      {r.sourceDocument ? <PdfPane recordId={r.id} filename={r.sourceDocument.originalFilename} /> : <div />}
      <div />
      <div className="reading">
        <div className="notice t-info">
          <b>Draft — nothing has been read yet</b>
          <span>
            Check this is the right document, then publish it. Publishing sends the PDF for extraction;
            it does not send anything to SAP.
          </span>
        </div>
        <section className="sec">
          <div className="sec-head"><h2>Document</h2></div>
          <dl className="kv">
            <dt>File</dt><dd>{r.sourceDocument?.originalFilename}</dd>
            <dt>Size</dt><dd className="tnum">{((r.sourceDocument?.byteSize ?? 0) / 1024).toFixed(1)} KB</dd>
            <dt>Pages</dt><dd>{r.sourceDocument?.pageCount ?? 'unknown'}</dd>
            <dt>SHA-256</dt><dd className="mono faint">{r.sourceDocument?.contentHash.slice(0, 32)}…</dd>
            <dt>Uploaded by</dt><dd>{r.uploadedBy.name}</dd>
            <dt>Correlation id</dt><dd className="mono">{r.correlationId}</dd>
          </dl>
        </section>
        <History d={d} />
      </div>
    </div>
  );
}

/** FR-12.5 / FR-13.4 — submissions, SAP results and the audit trail. */
function History({ d }: { d: RecordDetail }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="sec">
      <div className="sec-head">
        <h2>History &amp; audit trail</h2>
        <span className="count-chip tnum">{d.audit.length}</span>
        <div className="spacer" />
        <button className="quiet sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>

      {open && (
        <>
          {d.submissions.length > 0 && (
            <>
              <p className="cap" style={{ margin: '4px 0 6px' }}>Submissions to SAP</p>
              <div className="lines">
                <table className="lines">
                  <thead>
                    <tr><th className="num">Attempt</th><th>Approved by</th><th>File written</th><th>Checksum</th></tr>
                  </thead>
                  <tbody>
                    {d.submissions.map((s) => (
                      <tr key={s.id}>
                        <td className="num tnum">{s.attempt}</td>
                        <td>{s.approvedBy.name}</td>
                        <td className="mono faint">{s.outboundFilename ?? (s.writeError ? `failed: ${s.writeError}` : 'pending')}</td>
                        <td className="mono faint">{s.checksum?.slice(0, 12) ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {d.results.length > 0 && (
            <>
              <p className="cap" style={{ margin: '14px 0 6px' }}>Results from SAP</p>
              <div className="lines">
                <table className="lines">
                  <thead>
                    <tr><th className="num">Attempt</th><th>Outcome</th><th>SO / error</th><th>File</th></tr>
                  </thead>
                  <tbody>
                    {d.results.map((res) => (
                      <tr key={res.id}>
                        <td className="num tnum">{res.attempt ?? '—'}</td>
                        <td>
                          <span className={`state ${res.outcome === 'SUCCESS' ? 't-ok' : 't-crit'}`}>
                            <span className="lamp" aria-hidden="true" />
                            <span className="glyph" aria-hidden="true">{res.outcome === 'SUCCESS' ? '✓' : '✕'}</span>
                            {res.outcome}
                          </span>
                        </td>
                        <td className="mono">{res.soNumber ?? `${res.errorCode ?? ''} ${res.errorMessage ?? ''}`}</td>
                        <td className="mono faint">{res.sourceFilename}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <p className="cap" style={{ margin: '14px 0 6px' }}>Audit trail</p>
          <ul className="trail">
            {d.audit.map((a) => (
              <li key={a.id}>
                <time dateTime={a.timestamp}>{new Date(a.timestamp).toLocaleTimeString()}</time>
                <div>
                  <div className="ev">{a.eventType} · {a.actor?.name ?? a.actorName ?? 'system'}</div>
                  {a.message && <div className="msg">{a.message}</div>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
