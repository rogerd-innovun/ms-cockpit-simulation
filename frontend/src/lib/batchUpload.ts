/**
 * FR-1.7 — several PDFs in one action become several independent records, each sent for
 * extraction. This is the client-side loop that does it: one upload request and one publish
 * request per file, against the same endpoints a single upload uses. Nothing here is
 * all-or-nothing — a file that fails does not stop the others — and every record is
 * created, audited and checked exactly as if it had been uploaded on its own.
 *
 * It stops short of approval. Approving sends an order to SAP, and that stays a person's
 * decision on the review screen.
 */

/** A drop of more than this is almost certainly a mistake, and each file costs an extraction call. */
export const MAX_BATCH = 50;

/** Uploads in flight at once: enough to overlap the network, few enough not to swamp a free-tier host. */
const CONCURRENCY = 3;

export type BatchOutcome =
  /** Uploaded and handed to extraction. */
  | { file: string; kind: 'queued'; recordId: string }
  /** Uploaded, but deliberately or necessarily not published; the record is a Draft to open. */
  | { file: string; kind: 'draft'; recordId: string; reason: string }
  /** Never uploaded, because there was nothing to gain (a repeat, or over the limit). */
  | { file: string; kind: 'skipped'; reason: string }
  /** Could not be uploaded at all. */
  | { file: string; kind: 'failed'; reason: string };

export interface UploadResult {
  record: { id: string };
  duplicates: Array<{ recordId: string; correlationId: string; status: string }>;
}

export interface BatchApi {
  upload(file: File): Promise<UploadResult>;
  publish(recordId: string): Promise<unknown>;
}

export interface BatchOptions {
  /** Called after every file settles: how many are done out of how many were taken on. */
  onProgress?: (done: number, total: number) => void;
  /** SHA-256 hex of the file; `null` when it cannot be computed. Injected so tests need no crypto. */
  hash?: (file: File) => Promise<string | null>;
}

async function sha256(file: File): Promise<string | null> {
  // crypto.subtle exists only in secure contexts (https or localhost); without it the
  // in-batch repeat check is skipped and the server's own duplicate check still applies.
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const digest = await subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

const reasonOf = (err: unknown, fallback: string): string =>
  err instanceof Error && err.message ? err.message : fallback;

const isSessionExpired = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'SESSION_EXPIRED';

/**
 * Upload every file and publish it. Outcomes come back in the order the files were given,
 * whatever order they finished in.
 */
export async function uploadAndPublishAll(
  files: File[],
  api: BatchApi,
  { onProgress, hash = sha256 }: BatchOptions = {},
): Promise<BatchOutcome[]> {
  const outcomes: Array<BatchOutcome | undefined> = new Array(files.length);
  const work: number[] = [];
  const firstWithHash = new Map<string, string>();

  // Decide, before anything is sent, which files are worth sending. Hashing is done one file
  // at a time so a big drop is not read into memory all at once.
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    // Some sources drop files with an empty MIME type; the server checks the real content,
    // so only turn away a file that positively claims to be something else.
    if (file.type && file.type !== 'application/pdf') {
      outcomes[i] = { file: file.name, kind: 'failed', reason: 'Not a PDF.' };
      continue;
    }
    if (work.length >= MAX_BATCH) {
      outcomes[i] = {
        file: file.name,
        kind: 'skipped',
        reason: `Not uploaded: ${MAX_BATCH} files is the most in one go. Add it again afterwards.`,
      };
      continue;
    }
    const digest = await hash(file);
    const twin = digest ? firstWithHash.get(digest) : undefined;
    if (twin) {
      // Sent together, two identical files would race each other past the server's duplicate
      // check and both be published. One copy is the sensible reading of the drop.
      outcomes[i] = { file: file.name, kind: 'skipped', reason: `Same file as ${twin}, which is already in this batch.` };
      continue;
    }
    if (digest) firstWithHash.set(digest, file.name);
    work.push(i);
  }

  let done = files.length - work.length;
  onProgress?.(done, files.length);
  let aborted = false;

  const one = async (i: number) => {
    const file = files[i]!;
    if (aborted) {
      outcomes[i] = { file: file.name, kind: 'skipped', reason: 'Not uploaded: your session ended.' };
      return;
    }
    let uploaded: UploadResult;
    try {
      uploaded = await api.upload(file);
    } catch (err) {
      if (isSessionExpired(err)) aborted = true;
      outcomes[i] = { file: file.name, kind: 'failed', reason: reasonOf(err, 'The upload did not complete.') };
      return;
    }
    const recordId = uploaded.record.id;

    // The same bytes as a record already in the system. Publishing would either be refused or
    // quietly send the same order twice, so it is left as a Draft for a person to decide
    // (publishing a duplicate asks for a reason, which goes in the audit trail).
    if (uploaded.duplicates.length > 0) {
      const named = uploaded.duplicates
        .slice(0, 2)
        .map((d) => `${d.correlationId} (${d.status})`)
        .join(', ');
      outcomes[i] = {
        file: file.name,
        kind: 'draft',
        recordId,
        reason: `Identical to ${named}${uploaded.duplicates.length > 2 ? ' and others' : ''}. Left as a draft; open it to publish with a reason.`,
      };
      return;
    }

    try {
      await api.publish(recordId);
      outcomes[i] = { file: file.name, kind: 'queued', recordId };
    } catch (err) {
      if (isSessionExpired(err)) aborted = true;
      outcomes[i] = {
        file: file.name,
        kind: 'draft',
        recordId,
        reason: `Uploaded, but not sent for extraction: ${reasonOf(err, 'the request did not complete')}. Open it and press Publish.`,
      };
    }
  };

  // A small pool: each worker takes the next unclaimed file until none are left.
  let next = 0;
  const worker = async () => {
    while (next < work.length) {
      const i = work[next++]!;
      await one(i);
      onProgress?.(++done, files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, worker));

  return outcomes as BatchOutcome[];
}

export function summarise(outcomes: BatchOutcome[]) {
  const count = (kind: BatchOutcome['kind']) => outcomes.filter((o) => o.kind === kind).length;
  return { queued: count('queued'), draft: count('draft'), skipped: count('skipped'), failed: count('failed') };
}
