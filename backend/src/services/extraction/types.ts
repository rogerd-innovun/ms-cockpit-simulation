import type { ExtractionResult } from '../../domain/types.js';

export interface ExtractionRequest {
  pdf: Buffer;
  prompt: string;
  promptVersion: string;
  timeoutMs: number;
}

export interface ExtractionResponse {
  result: ExtractionResult;
  raw: unknown;
  model: string;
  provider: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ExtractionProvider {
  readonly name: string;
  extract(req: ExtractionRequest): Promise<ExtractionResponse>;
}

/** Distinguishes "retry this" from "this will never work". FR-4.11. */
export class ExtractionError extends Error {
  constructor(
    override readonly message: string,
    readonly retryable: boolean,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}
