import { STATUS_META, toneClass } from '../lib/status';
import type { POStatus } from '../lib/types';

/** NFR-4.4 — a lamp, a glyph and a word. Colour is never the only channel. */
export function StatusBadge({ status }: { status: POStatus }) {
  const s = STATUS_META[status];
  return (
    <span className={`state ${toneClass(s.tone)}`} title={status}>
      <span className="lamp" aria-hidden="true" />
      <span className="glyph" aria-hidden="true">{s.glyph}</span>
      {s.label}
    </span>
  );
}

export { statusLabel } from '../lib/status';
