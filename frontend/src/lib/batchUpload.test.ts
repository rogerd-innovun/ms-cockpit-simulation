import { describe, expect, it } from 'vitest';
import {
  MAX_BATCH,
  summarise,
  uploadAndPublishAll,
  type BatchApi,
  type UploadResult,
} from './batchUpload';

const pdf = (name: string, body = name) => new File([`%PDF-1.4 ${body}`], name, { type: 'application/pdf' });

/** A stand-in server: records what was called, in what order, and lets a test make parts of it fail. */
function fakeApi(opts: {
  duplicatesFor?: Record<string, UploadResult['duplicates']>;
  failUpload?: (name: string) => Error | undefined;
  failPublish?: (id: string) => Error | undefined;
  delayMs?: number;
} = {}) {
  const calls: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const idOf = new Map<string, string>();
  const api: BatchApi = {
    async upload(file) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      calls.push(`upload ${file.name}`);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      inFlight--;
      const err = opts.failUpload?.(file.name);
      if (err) throw err;
      const id = `rec-${file.name}`;
      idOf.set(id, file.name);
      return { record: { id }, duplicates: opts.duplicatesFor?.[file.name] ?? [] };
    },
    async publish(id) {
      calls.push(`publish ${idOf.get(id)}`);
      const err = opts.failPublish?.(id);
      if (err) throw err;
    },
  };
  return { api, calls, peak: () => peak };
}

// Hash by name, so a test can say "these two are the same bytes" without reading real files.
const byName = async (f: File) => `hash:${f.name.replace(/ \(copy\)/, '')}`;

describe('uploadAndPublishAll', () => {
  it('uploads every file and publishes each one as its own record', async () => {
    const { api, calls } = fakeApi();
    const files = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf'].map((n) => pdf(n));
    const out = await uploadAndPublishAll(files, api, { hash: byName });
    expect(out.map((o) => o.kind)).toEqual(['queued', 'queued', 'queued', 'queued']);
    expect(out.map((o) => o.file)).toEqual(['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf']);
    expect(calls.filter((c) => c.startsWith('upload')).length).toBe(4);
    expect(calls.filter((c) => c.startsWith('publish')).length).toBe(4);
    // Each file is published only after its own upload.
    for (const n of ['a', 'b', 'c', 'd']) {
      expect(calls.indexOf(`publish ${n}.pdf`)).toBeGreaterThan(calls.indexOf(`upload ${n}.pdf`));
    }
    expect(summarise(out)).toEqual({ queued: 4, draft: 0, skipped: 0, failed: 0 });
  });

  it('keeps outcomes in the order the files were given, whatever order they finish in', async () => {
    const files = ['slow.pdf', 'fast.pdf'].map((n) => pdf(n));
    const calls: string[] = [];
    const api: BatchApi = {
      async upload(file) {
        await new Promise((r) => setTimeout(r, file.name === 'slow.pdf' ? 30 : 1));
        return { record: { id: file.name }, duplicates: [] };
      },
      async publish(id) {
        calls.push(id);
      },
    };
    const out = await uploadAndPublishAll(files, api, { hash: byName });
    expect(calls).toEqual(['fast.pdf', 'slow.pdf']);
    expect(out.map((o) => o.file)).toEqual(['slow.pdf', 'fast.pdf']);
  });

  it('never has more than three uploads in flight at once', async () => {
    const { api, peak } = fakeApi({ delayMs: 5 });
    const files = Array.from({ length: 10 }, (_, i) => pdf(`f${i}.pdf`));
    await uploadAndPublishAll(files, api, { hash: byName });
    expect(peak()).toBeLessThanOrEqual(3);
    expect(peak()).toBeGreaterThan(1);
  });

  it('one failure does not stop the others', async () => {
    const { api } = fakeApi({ failUpload: (n) => (n === 'b.pdf' ? new Error('File is 25.0 MB; the limit is 20 MB.') : undefined) });
    const out = await uploadAndPublishAll(['a.pdf', 'b.pdf', 'c.pdf'].map((n) => pdf(n)), api, { hash: byName });
    expect(out.map((o) => o.kind)).toEqual(['queued', 'failed', 'queued']);
    expect(out[1]).toMatchObject({ kind: 'failed', reason: 'File is 25.0 MB; the limit is 20 MB.' });
  });

  it('leaves a file that duplicates an existing record as a draft, unpublished, and names the match', async () => {
    const { api, calls } = fakeApi({
      duplicatesFor: { 'b.pdf': [{ recordId: 'x', correlationId: 'COR-1', status: 'SO_CREATED' }] },
    });
    const out = await uploadAndPublishAll(['a.pdf', 'b.pdf'].map((n) => pdf(n)), api, { hash: byName });
    expect(out[0]!.kind).toBe('queued');
    expect(out[1]).toMatchObject({ kind: 'draft', recordId: 'rec-b.pdf' });
    expect((out[1] as { reason: string }).reason).toContain('COR-1 (SO_CREATED)');
    expect(calls).not.toContain('publish b.pdf');
  });

  it('keeps the record, as a draft, when publishing fails after the upload worked', async () => {
    const { api } = fakeApi({ failPublish: () => new Error('This PDF is identical to an existing record') });
    const out = await uploadAndPublishAll([pdf('a.pdf')], api, { hash: byName });
    expect(out[0]).toMatchObject({ kind: 'draft', recordId: 'rec-a.pdf' });
    expect((out[0] as { reason: string }).reason).toContain('identical to an existing record');
  });

  it('sends one copy of a file selected twice', async () => {
    const { api, calls } = fakeApi();
    const out = await uploadAndPublishAll([pdf('a.pdf'), pdf('a (copy).pdf'), pdf('b.pdf')], api, { hash: byName });
    expect(out.map((o) => o.kind)).toEqual(['queued', 'skipped', 'queued']);
    expect((out[1] as { reason: string }).reason).toContain('a.pdf');
    expect(calls).not.toContain('upload a (copy).pdf');
  });

  it('turns away a file that says it is not a PDF, and sends the rest', async () => {
    const { api, calls } = fakeApi();
    const txt = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const out = await uploadAndPublishAll([pdf('a.pdf'), txt], api, { hash: byName });
    expect(out.map((o) => o.kind)).toEqual(['queued', 'failed']);
    expect(calls).not.toContain('upload notes.txt');
  });

  it('accepts a file with an empty MIME type and leaves the content check to the server', async () => {
    const { api } = fakeApi();
    const bare = new File(['%PDF-1.4'], 'scan.pdf', { type: '' });
    const out = await uploadAndPublishAll([bare], api, { hash: byName });
    expect(out[0]!.kind).toBe('queued');
  });

  it(`takes at most ${MAX_BATCH} files and says so about the rest`, async () => {
    const { api, calls } = fakeApi();
    const files = Array.from({ length: MAX_BATCH + 3 }, (_, i) => pdf(`f${i}.pdf`));
    const out = await uploadAndPublishAll(files, api, { hash: byName });
    expect(out.filter((o) => o.kind === 'queued').length).toBe(MAX_BATCH);
    expect(out.slice(MAX_BATCH).every((o) => o.kind === 'skipped')).toBe(true);
    expect(calls.filter((c) => c.startsWith('upload')).length).toBe(MAX_BATCH);
  });

  it('stops uploading once the session has ended', async () => {
    const expired = Object.assign(new Error('Your session has expired. Sign in again.'), { code: 'SESSION_EXPIRED' });
    const { api, calls } = fakeApi({ failUpload: () => expired });
    const files = Array.from({ length: 8 }, (_, i) => pdf(`f${i}.pdf`));
    const out = await uploadAndPublishAll(files, api, { hash: byName });
    expect(out.every((o) => o.kind === 'failed' || o.kind === 'skipped')).toBe(true);
    // The first wave (three) was already in flight; nothing after it was attempted.
    expect(calls.filter((c) => c.startsWith('upload')).length).toBeLessThan(8);
  });

  it('reports progress up to the full count', async () => {
    const { api } = fakeApi();
    const seen: Array<[number, number]> = [];
    await uploadAndPublishAll(['a.pdf', 'b.pdf', 'c.pdf'].map((n) => pdf(n)), api, {
      hash: byName,
      onProgress: (d, t) => seen.push([d, t]),
    });
    expect(seen[seen.length - 1]).toEqual([3, 3]);
    expect(seen.every(([, t]) => t === 3)).toBe(true);
  });

  it('works with the real SHA-256: identical bytes under different names count as one', async () => {
    const { api } = fakeApi();
    const a = new File(['%PDF-1.4 same'], 'one.pdf', { type: 'application/pdf' });
    const b = new File(['%PDF-1.4 same'], 'two.pdf', { type: 'application/pdf' });
    const c = new File(['%PDF-1.4 different'], 'three.pdf', { type: 'application/pdf' });
    const out = await uploadAndPublishAll([a, b, c], api);
    expect(out.map((o) => o.kind)).toEqual(['queued', 'skipped', 'queued']);
  });
});
