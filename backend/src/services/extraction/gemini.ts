import { GoogleGenAI, Type, type Schema } from '@google/genai';
import { env } from '../../config/env.js';
import { HEADER_FIELDS, LINE_FIELDS, extractionResultSchema } from '../../domain/types.js';
import { ExtractionError, type ExtractionProvider, type ExtractionRequest, type ExtractionResponse } from './types.js';

/**
 * FR-4.7 — the model is asked for a structured response conforming to this schema, not
 * for free text. FR-4.8 — every field carries its own confidence.
 */
const confidentValueSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    value: { type: Type.STRING, nullable: true, description: 'Verbatim value from the document, or null if absent.' },
    confidence: { type: Type.NUMBER, description: 'Certainty that this value was read correctly, 0.0 to 1.0.' },
  },
  required: ['value', 'confidence'],
};

const objectOf = (fields: readonly string[], extra: Record<string, Schema> = {}): Schema => ({
  type: Type.OBJECT,
  properties: {
    ...extra,
    ...Object.fromEntries(fields.map((f) => [f, confidentValueSchema])),
  },
  required: [...Object.keys(extra), ...fields],
});

export const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    header: objectOf(HEADER_FIELDS),
    lineItems: {
      type: Type.ARRAY,
      items: objectOf(LINE_FIELDS, {
        lineNumber: { type: Type.INTEGER, description: 'Sequential line number starting at 1.' },
      }),
    },
    vendorIdentified: { type: Type.STRING, nullable: true },
  },
  required: ['header', 'lineItems'],
};

/** Transient conditions worth a retry; anything else fails the attempt outright. */
function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500;
  const msg = String((err as Error)?.message ?? '').toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('aborted') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('fetch failed') ||
    msg.includes('overloaded') ||
    msg.includes('unavailable') ||
    msg.includes('rate limit')
  );
}

export class GeminiExtractionProvider implements ExtractionProvider {
  readonly name = 'gemini';
  private readonly client: GoogleGenAI;

  constructor(apiKey: string = env.GEMINI_API_KEY) {
    if (!apiKey) {
      throw new Error(
        'GEMINI_API_KEY is not set. Set it in backend/.env, or set EXTRACTION_PROVIDER=mock to run without it.',
      );
    }
    this.client = new GoogleGenAI({ apiKey });
  }

  async extract(req: ExtractionRequest): Promise<ExtractionResponse> {
    const started = Date.now();
    const controller = new AbortController();
    // FR-4.10 — bound the call; a hung request must not hold a record in PROCESSING.
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);

    let response;
    try {
      response = await this.client.models.generateContent({
        model: env.GEMINI_MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'application/pdf', data: req.pdf.toString('base64') } },
              { text: req.prompt },
            ],
          },
        ],
        config: {
          abortSignal: controller.signal,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          // Extraction is a reading task, not a creative one.
          temperature: 0,
        },
      });
    } catch (err) {
      throw new ExtractionError(
        `Gemini request failed: ${(err as Error).message}`,
        isRetryable(err),
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - started;
    const text = response.text;
    if (!text) {
      throw new ExtractionError('Gemini returned an empty response.', true);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // FR-4.13 — malformed output is a failed attempt, never reviewable data.
      throw new ExtractionError('Gemini returned a response that was not valid JSON.', true);
    }

    const validated = extractionResultSchema.safeParse(parsed);
    if (!validated.success) {
      throw new ExtractionError(
        `Gemini response did not match the extraction schema: ${validated.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
        true,
        validated.error,
      );
    }

    return {
      result: validated.data,
      raw: parsed,
      model: env.GEMINI_MODEL,
      provider: this.name,
      latencyMs,
      inputTokens: response.usageMetadata?.promptTokenCount ?? null,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
    };
  }
}
