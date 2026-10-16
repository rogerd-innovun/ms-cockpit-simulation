export interface ResultLike {
  outcome: 'SUCCESS' | 'ERROR';
  soNumber: string | null;
  attempt: number | null;
  quarantined: boolean;
  ingestedAt: Date;
  sapTimestamp: string | null;
}

export interface UnlinkedOrder {
  soNumber: string;
  attempt: number | null;
  ingestedAt: Date;
  sapTimestamp: string | null;
}

/** SAP pads document numbers with leading zeros in some places and not in others. */
const canonical = (so: string) => so.trim().replace(/^0+/, '');

/**
 * Sales Orders SAP says it created for this record that the record is not linked to.
 *
 * A result that cannot change the record's status (it answered a superseded attempt, or
 * the record had moved on) is stored rather than discarded, and this is what reads those
 * back. The usual cause is an attempt that timed out, was resubmitted, and was then
 * answered after all: SAP holds an order from attempt 1 and will be sent another from
 * attempt 2. The reviewer needs to hear that before approving, or afterwards to cancel
 * the extra one in SAP.
 *
 * The order the record IS linked to never appears, nor does a quarantined file (it was
 * never accepted as a result), nor the same number reported twice.
 */
export function unlinkedOrders(recordSoNumber: string | null, results: ResultLike[]): UnlinkedOrder[] {
  const linked = recordSoNumber ? canonical(recordSoNumber) : null;
  const seen = new Set<string>();
  const out: UnlinkedOrder[] = [];
  for (const r of results) {
    if (r.quarantined || r.outcome !== 'SUCCESS' || !r.soNumber) continue;
    const key = canonical(r.soNumber);
    if (!key || key === linked || seen.has(key)) continue;
    seen.add(key);
    out.push({ soNumber: r.soNumber, attempt: r.attempt, ingestedAt: r.ingestedAt, sapTimestamp: r.sapTimestamp });
  }
  return out;
}
