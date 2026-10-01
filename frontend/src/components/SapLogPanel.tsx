import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import type { SapLogCall } from '../lib/types';

/**
 * ZEE_API_LOG — this record's Sales Order sent to SAP as IT_SALEORDERS-VBELN (CHAR10),
 * and what SAP answered. Hidden entirely while the API is switched off.
 */
export function SapLogPanel({ recordId }: { recordId: string }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const state = useQuery({ queryKey: ['sap-log', recordId], queryFn: () => api.sapLog(recordId) });

  const call = useMutation({
    mutationFn: () => api.callSapLog(recordId),
    onMutate: () => setError(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sap-log', recordId] });
      // The call is written to the audit trail, so the History section has a new row.
      qc.invalidateQueries({ queryKey: ['record', recordId] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'The call could not be made.'),
  });

  const s = state.data;
  if (!s || s.mode === 'off') return null;
  const [latest, ...earlier] = s.calls;

  return (
    <section className="sec sap-log">
      <div className="sec-head">
        <h2>SAP log</h2>
        <span className="mono faint">{s.api}</span>
        {s.mode === 'mock' && (
          <span className="count-chip" title="SAP_LOG_API_MODE=mock: answered inside the cockpit, no SAP system is called">
            mock
          </span>
        )}
        <div className="spacer" />
        <button
          className="sm"
          disabled={call.isPending || !s.vbeln}
          title={s.vbelnError ?? `Send VBELN ${s.vbeln} to ${s.api}`}
          onClick={() => call.mutate()}
        >
          {call.isPending ? 'Calling SAP…' : `Call ${s.api}`}
        </button>
      </div>

      <dl className="kv">
        <dt>Sales Order</dt>
        <dd className="mono">{s.soNumber ?? '—'}</dd>
        <dt>IT_SALEORDERS-VBELN</dt>
        <dd className="mono">
          {s.vbeln ?? <span className="t-crit">{s.vbelnError}</span>} <span className="faint">CHAR10</span>
        </dd>
      </dl>

      {error && (
        <div className="notice t-crit" style={{ marginTop: 10 }}>
          <b>{error}</b>
        </div>
      )}

      {latest ? <CallView call={latest} /> : <p className="cap" style={{ marginTop: 10 }}>Not called yet.</p>}
      {earlier.length > 0 && (
        <p className="cap" style={{ marginTop: 6 }}>
          {earlier.length} earlier call{earlier.length === 1 ? '' : 's'} in the audit trail.
        </p>
      )}
    </section>
  );
}

function CallView({ call }: { call: SapLogCall }) {
  const [showRequest, setShowRequest] = useState(false);
  const body =
    call.response == null
      ? null
      : typeof call.response === 'string'
        ? call.response
        : JSON.stringify(call.response, null, 2);

  return (
    <div className={`notice ${call.ok ? 't-ok' : 't-crit'}`} style={{ marginTop: 12 }}>
      <b>
        <span className="glyph mono" aria-hidden="true">{call.ok ? '✓ ' : '✕ '}</span>
        {call.ok ? `SAP answered HTTP ${call.httpStatus}` : (call.error ?? 'The call failed')}
      </b>
      <span className="cap tnum">
        {call.mode} · {call.format} · {call.durationMs} ms
        {call.calledBy && <> · {call.calledBy}</>}
        {call.timestamp && <> · {new Date(call.timestamp).toLocaleString()}</>}
      </span>
      {call.endpoint && <span className="raw">{call.endpoint}</span>}
      {body && <pre>{body}</pre>}
      <div>
        <button className="quiet sm" onClick={() => setShowRequest((v) => !v)} aria-expanded={showRequest}>
          {showRequest ? 'Hide' : 'Show'} what was sent
        </button>
      </div>
      {showRequest && <pre>{call.requestBody}</pre>}
    </div>
  );
}
