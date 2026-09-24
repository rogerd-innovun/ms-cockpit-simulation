import type { VendorProfile } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import { childLogger } from '../../lib/logger.js';
import { assertTransition } from '../../domain/status.js';
import {
  HEADER_FIELDS,
  LINE_FIELDS,
  headerFieldPath,
  lineFieldPath,
  type ExtractionResult,
  type HeaderField,
  type LineField,
} from '../../domain/types.js';
import { writeAudit } from '../audit.js';
import { loadDocumentContent } from '../storage.js';
import { GeminiExtractionProvider } from './gemini.js';
import { MockExtractionProvider } from './mock.js';
import { GENERIC_EXTRACTION_PROMPT, GENERIC_PROMPT_VERSION, buildVendorPrompt } from './prompts.js';
import { ExtractionError, type ExtractionProvider } from './types.js';

const log = childLogger('extraction');

let provider: ExtractionProvider | null = null;

export function getProvider(): ExtractionProvider {
  if (!provider) {
    provider =
      env.EXTRACTION_PROVIDER === 'mock'
        ? new MockExtractionProvider()
        : new GeminiExtractionProvider();
  }
  return provider;
}

/** Test seam. */
export function setProvider(p: ExtractionProvider | null): void {
  provider = p;
}

/**
 * FR-4.2 / FR-4.3 — identify the vendor from the user's hint or from markers in the
 * document, and fall back to the generic prompt when nothing matches.
 *
 * The text scan is a byte-level search of the raw PDF, which finds markers in
 * text-bearing PDFs and silently finds nothing in pure scans. That is the correct
 * failure mode: an unmatched profile costs extraction quality, a wrongly matched one
 * costs correctness.
 */
export async function matchVendorProfile(
  pdf: Buffer,
  vendorHint: string | null,
): Promise<VendorProfile | null> {
  const profiles = await prisma.vendorProfile.findMany({ where: { active: true } });
  if (profiles.length === 0) return null;

  if (vendorHint) {
    const hint = vendorHint.trim().toLowerCase();
    const byName = profiles.find((p) => p.name.toLowerCase() === hint);
    if (byName) return byName;
  }

  const text = pdf.toString('latin1').toLowerCase();
  for (const profile of profiles) {
    const hints = profile.identificationHints as { markers?: string[] } | null;
    const markers = hints?.markers ?? [];
    if (markers.length > 0 && markers.some((m) => text.includes(m.toLowerCase()))) {
      return profile;
    }
  }
  return null;
}

/**
 * FR-3.2, FR-4 — run extraction for one record and land it in NEEDS_REVIEW or
 * EXTRACTION_FAILED. Safe to call only on a record in PUBLISHED or EXTRACTION_FAILED.
 */
export async function runExtractionForRecord(recordId: string): Promise<void> {
  const record = await prisma.pORecord.findUnique({
    where: { id: recordId },
    include: { sourceDocument: true },
  });
  if (!record || !record.sourceDocument) {
    log.warn({ recordId }, 'record or source document missing; skipping');
    return;
  }

  assertTransition(record.status, 'PROCESSING');
  await prisma.pORecord.update({
    where: { id: recordId },
    data: { status: 'PROCESSING', statusChangedAt: new Date() },
  });
  await writeAudit({
    recordId,
    eventType: 'STATUS_CHANGED',
    message: `${record.status} → PROCESSING`,
    actorName: 'extraction-worker',
  });

  const pdf = await loadDocumentContent(recordId, record.sourceDocument.storagePath);
  if (!pdf) {
    // Neither the disk cache nor the database copy exists — an unretryable loss, so
    // land in EXTRACTION_FAILED rather than throwing and stranding the record in
    // PROCESSING, a status no worker ever picks back up.
    const message =
      'The uploaded PDF is no longer available (the host disk was cleared and no database copy exists). Upload it again.';
    await prisma.pORecord.update({
      where: { id: recordId },
      data: { status: 'EXTRACTION_FAILED', statusChangedAt: new Date() },
    });
    await writeAudit({
      recordId,
      eventType: 'EXTRACTION_FAILED',
      message,
      actorName: 'extraction-worker',
    });
    await writeAudit({
      recordId,
      eventType: 'STATUS_CHANGED',
      message: 'PROCESSING → EXTRACTION_FAILED',
      actorName: 'extraction-worker',
    });
    log.error({ recordId }, 'source document missing from disk and database');
    return;
  }
  const profile = await matchVendorProfile(pdf, record.vendorHint);
  const prompt = profile
    ? buildVendorPrompt(profile.name, profile.extractionPrompt)
    : GENERIC_EXTRACTION_PROMPT;
  const promptVersion = profile ? `${profile.name}-v${profile.version}` : GENERIC_PROMPT_VERSION;

  const attempt = (await prisma.extractionRun.count({ where: { recordId } })) + 1;
  const run = await prisma.extractionRun.create({
    data: {
      recordId,
      attempt,
      provider: getProvider().name,
      model: env.GEMINI_MODEL,
      promptVersion,
      vendorProfileId: profile?.id ?? null,
    },
  });

  await writeAudit({
    recordId,
    eventType: 'EXTRACTION_STARTED',
    message: profile
      ? `Extraction attempt ${attempt} using vendor profile "${profile.name}" v${profile.version}`
      : `Extraction attempt ${attempt} using the generic prompt (no vendor profile matched)`,
    actorName: 'extraction-worker',
  });

  // FR-4.11 — retry transient failures with exponential backoff.
  let lastError: ExtractionError | null = null;
  for (let tries = 1; tries <= env.EXTRACTION_MAX_ATTEMPTS; tries++) {
    try {
      const response = await getProvider().extract({
        pdf,
        prompt,
        promptVersion,
        timeoutMs: env.EXTRACTION_TIMEOUT_MS,
      });

      await persistExtraction(recordId, response.result, profile?.id ?? null);

      await prisma.extractionRun.update({
        where: { id: run.id },
        data: {
          outcome: 'SUCCESS',
          latencyMs: response.latencyMs,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          rawResponse: response.raw as never,
          model: response.model,
          finishedAt: new Date(),
        },
      });

      await prisma.pORecord.update({
        where: { id: recordId },
        data: {
          status: 'NEEDS_REVIEW',
          statusChangedAt: new Date(),
          vendorProfileId: profile?.id ?? null,
        },
      });

      await writeAudit({
        recordId,
        eventType: 'EXTRACTION_SUCCEEDED',
        message: `Extracted ${response.result.lineItems.length} line item(s) in ${response.latencyMs}ms`,
        actorName: 'extraction-worker',
      });
      await writeAudit({
        recordId,
        eventType: 'STATUS_CHANGED',
        message: 'PROCESSING → NEEDS_REVIEW',
        actorName: 'extraction-worker',
      });
      log.info({ recordId, attempt, tries }, 'extraction succeeded');
      return;
    } catch (err) {
      lastError =
        err instanceof ExtractionError
          ? err
          : new ExtractionError((err as Error).message, false, err);
      log.warn({ recordId, tries, err: lastError.message }, 'extraction attempt failed');

      if (!lastError.retryable || tries === env.EXTRACTION_MAX_ATTEMPTS) break;
      await writeAudit({
        recordId,
        eventType: 'EXTRACTION_RETRIED',
        message: `Attempt ${tries} failed (${lastError.message}); retrying`,
        actorName: 'extraction-worker',
      });
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (tries - 1)));
    }
  }

  // FR-4.12 — out of attempts.
  const message = lastError?.message ?? 'Extraction failed for an unknown reason.';
  await prisma.extractionRun.update({
    where: { id: run.id },
    data: { outcome: 'FAILED', errorMessage: message, finishedAt: new Date() },
  });
  await prisma.pORecord.update({
    where: { id: recordId },
    data: { status: 'EXTRACTION_FAILED', statusChangedAt: new Date() },
  });
  await writeAudit({
    recordId,
    eventType: 'EXTRACTION_FAILED',
    message,
    actorName: 'extraction-worker',
  });
  await writeAudit({
    recordId,
    eventType: 'STATUS_CHANGED',
    message: 'PROCESSING → EXTRACTION_FAILED',
    actorName: 'extraction-worker',
  });
  log.error({ recordId, message }, 'extraction failed');
}

/**
 * FR-5.4 — store the current values (used for validation and CSV) alongside per-field
 * provenance (what the model said, and how sure it was). The extracted value is kept
 * even after a human overwrites the current value.
 */
async function persistExtraction(
  recordId: string,
  result: ExtractionResult,
  _vendorProfileId: string | null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.pOHeader.deleteMany({ where: { recordId } });
    await tx.fieldExtraction.deleteMany({ where: { recordId } });

    const header = await tx.pOHeader.create({
      data: {
        recordId,
        ...Object.fromEntries(
          HEADER_FIELDS.map((f) => [f, result.header[f]?.value ?? null]),
        ),
      },
    });

    const sorted = [...result.lineItems].sort((a, b) => a.lineNumber - b.lineNumber);
    // FR-5.3 — renumber sequentially so a model that repeats or skips a number cannot
    // collide on the (headerId, lineNumber) unique constraint.
    await tx.pOLineItem.createMany({
      data: sorted.map((line, idx) => ({
        headerId: header.id,
        lineNumber: idx + 1,
        ...Object.fromEntries(LINE_FIELDS.map((f) => [f, line[f]?.value ?? null])),
      })),
    });

    const provenance = [
      ...HEADER_FIELDS.map((f: HeaderField) => ({
        recordId,
        fieldPath: headerFieldPath(f),
        extractedValue: result.header[f]?.value ?? null,
        confidence: result.header[f]?.confidence ?? null,
      })),
      ...sorted.flatMap((line, idx) =>
        LINE_FIELDS.map((f: LineField) => ({
          recordId,
          fieldPath: lineFieldPath(idx + 1, f),
          extractedValue: line[f]?.value ?? null,
          confidence: line[f]?.confidence ?? null,
        })),
      ),
    ];
    await tx.fieldExtraction.createMany({ data: provenance });
  });
}
