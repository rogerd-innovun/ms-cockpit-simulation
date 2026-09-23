import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { sha256 } from '../lib/ids.js';

/**
 * FR-1.1 / FR-1.9 — the original PDF is stored unmodified and stays viewable at every
 * later stage. Files are addressed by record id so that a leaked storage path for one
 * record reveals nothing about another (NFR-3.5 is enforced at the API layer).
 */
export async function ensureDirectories(): Promise<void> {
  await Promise.all(
    [
      env.paths.documents,
      env.paths.outbound,
      env.paths.staging,
      env.paths.inbound,
      env.paths.archive,
      env.paths.quarantine,
    ].map((dir) => fs.mkdir(dir, { recursive: true })),
  );
}

export interface StoredDocument {
  storagePath: string;
  contentHash: string;
  byteSize: number;
  pageCount: number | null;
}

export async function storeDocument(recordId: string, buffer: Buffer): Promise<StoredDocument> {
  const dir = path.join(env.paths.documents, recordId);
  await fs.mkdir(dir, { recursive: true });
  const storagePath = path.join(dir, 'original.pdf');
  await fs.writeFile(storagePath, buffer);
  return {
    storagePath,
    contentHash: sha256(buffer),
    byteSize: buffer.byteLength,
    pageCount: countPdfPages(buffer),
  };
}

export async function readDocument(storagePath: string): Promise<Buffer> {
  return fs.readFile(storagePath);
}

export async function deleteDocument(recordId: string): Promise<void> {
  await fs.rm(path.join(env.paths.documents, recordId), { recursive: true, force: true });
}

/**
 * Page count without pulling in a PDF library: count the /Type /Page objects and fall
 * back to null rather than guessing. Only used for display, never for logic.
 */
function countPdfPages(buffer: Buffer): number | null {
  const text = buffer.toString('latin1');
  const matches = text.match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : null;
}

/** FR-1.2 — validate by content, not by filename extension (NFR-3.4). */
export function looksLikePdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}
