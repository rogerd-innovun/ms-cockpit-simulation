import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/**
 * FR-7.1 — the original PDF, held next to the reading of it.
 *
 * The document sits behind an authorised endpoint (NFR-3.5), so it is fetched as a
 * blob and shown through an object URL rather than linked directly. Page navigation,
 * zoom and text search come from the browser's own PDF viewer; a milestone-2 pdf.js
 * pane would add per-field source highlighting (FR-7.4), which needs coordinates the
 * extractor does not return yet.
 */
export function PdfPane({ recordId, filename }: { recordId: string; filename: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;

    api
      .documentUrl(recordId)
      .then((objectUrl) => {
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        revoked = objectUrl;
        setUrl(objectUrl);
      })
      .catch(() => setError('The source PDF could not be loaded. Try reloading the page.'));

    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [recordId]);

  return (
    <div className="doc">
      <div className="doc-bar">
        <span className="cap">Source</span>
        <span className="mono faint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={filename}>
          {filename}
        </span>
        <div className="spacer" />
        {url && <a href={url} target="_blank" rel="noreferrer">Open</a>}
      </div>
      {error ? (
        <div className="empty">{error}</div>
      ) : url ? (
        <iframe src={`${url}#view=FitH`} title="Original purchase order PDF" />
      ) : (
        <div className="empty">Loading document…</div>
      )}
    </div>
  );
}
