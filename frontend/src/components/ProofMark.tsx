import type { FieldProvenance } from '../lib/types';

/**
 * The margin mark. A field the model was sure about and nobody touched gets
 * NOTHING — silence is the signal that it is fine. Ink in the margin means a
 * person needs to look, or already did.
 *
 * FR-4.8 / FR-7.2. The threshold is the line the reviewer is judging against,
 * so the mark states the number rather than a bar you have to interpret.
 */
export function ProofMark({
  provenance,
  threshold,
  blocking,
}: {
  provenance?: FieldProvenance;
  threshold: number;
  blocking?: boolean;
}) {
  if (blocking) {
    return (
      <span className="mark t-crit" title="This must be fixed before the order can be approved">
        ✕
      </span>
    );
  }

  const edited = Boolean(provenance?.editedAt);
  if (edited) {
    return (
      <span
        className="mark t-info"
        title={`Changed by ${provenance?.editedBy?.name ?? 'a reviewer'}`}
      >
        ✎
      </span>
    );
  }

  const c = provenance?.confidence;
  if (c == null || c >= threshold) return <span className="gut-empty" aria-hidden="true" />;

  return (
    <span
      className="mark t-warn mark-pct"
      title={`The model was ${Math.round(c * 100)}% sure — below the ${Math.round(
        threshold * 100,
      )}% threshold, so it is flagged for you`}
    >
      {Math.round(c * 100)}
    </span>
  );
}
