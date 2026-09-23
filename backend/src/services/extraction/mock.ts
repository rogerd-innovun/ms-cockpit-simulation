import { HEADER_FIELDS, LINE_FIELDS, type ExtractionResult } from '../../domain/types.js';
import { sha256 } from '../../lib/ids.js';
import type { ExtractionProvider, ExtractionRequest, ExtractionResponse } from './types.js';

/**
 * A deterministic stand-in for the real extractor, used when EXTRACTION_PROVIDER=mock
 * and in tests. Output is derived from the PDF's hash, so the same document always
 * produces the same result, and some fields land below the confidence threshold on
 * purpose — a review screen that never has anything to review is not being tested.
 */
export class MockExtractionProvider implements ExtractionProvider {
  readonly name = 'mock';

  async extract(req: ExtractionRequest): Promise<ExtractionResponse> {
    const seed = sha256(req.pdf);
    const rand = seededRandom(seed);
    const started = Date.now();
    await new Promise((r) => setTimeout(r, 300));

    const lineCount = 2 + Math.floor(rand() * 3);
    const currency = 'EUR';
    const lines = Array.from({ length: lineCount }, (_, i) => {
      const qty = 5 + Math.floor(rand() * 200);
      const price = Math.round((10 + rand() * 400) * 100) / 100;
      return {
        lineNumber: i + 1,
        materialCode: cv(`MAT-${1000 + Math.floor(rand() * 9000)}`, rand, 0.6),
        customerMaterialNumber: cv(`CM-${100 + i}`, rand, 0.9),
        description: cv(`Mock material line ${i + 1}`, rand, 0.95),
        quantity: cv(String(qty), rand, 0.95),
        uom: cv(rand() > 0.7 ? 'PCS' : 'EA', rand, 0.8),
        unitPrice: cv(price.toFixed(2), rand, 0.9),
        lineNetValue: cv((qty * price).toFixed(2), rand, 0.9),
        deliveryDate: cv(null, rand, 0.95),
        plant: cv('1000', rand, 0.9),
      };
    });

    const total = lines.reduce((sum, l) => sum + Number(l.lineNetValue.value ?? 0), 0);

    const result: ExtractionResult = {
      header: {
        poNumber: cv(`PO-${seed.slice(0, 6).toUpperCase()}`, rand, 0.7),
        poDate: cv(new Date().toISOString().slice(0, 10), rand, 0.9),
        customerName: cv('Mock Industries GmbH', rand, 0.9),
        customerCode: cv(`C-${2000 + Math.floor(rand() * 999)}`, rand, 0.55),
        shipTo: cv('Werkstrasse 14, 40213 Düsseldorf, DE', rand, 0.85),
        billTo: cv('Postfach 220, 40213 Düsseldorf, DE', rand, 0.85),
        requestedDeliveryDate: cv(
          new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10),
          rand,
          0.8,
        ),
        currency: cv(currency, rand, 0.95),
        paymentTerms: cv('Net 30', rand, 0.85),
        incoterms: cv('DAP', rand, 0.8),
        poTotalValue: cv(total.toFixed(2), rand, 0.9),
        contact: cv('einkauf@mock-industries.example', rand, 0.9),
      } as ExtractionResult['header'],
      lineItems: lines as ExtractionResult['lineItems'],
      vendorIdentified: 'Mock Industries GmbH',
    };

    // Guard against a field being added to the domain and forgotten here.
    for (const f of HEADER_FIELDS) {
      if (!(f in result.header)) throw new Error(`Mock provider is missing header field ${f}`);
    }
    for (const f of LINE_FIELDS) {
      if (!(f in result.lineItems[0]!)) throw new Error(`Mock provider is missing line field ${f}`);
    }

    return {
      result,
      raw: result,
      model: 'mock-extractor-v1',
      provider: this.name,
      latencyMs: Date.now() - started,
      inputTokens: null,
      outputTokens: null,
    };
  }
}

/** ~30% of fields land below the 0.85 threshold so review has something to flag. */
function cv(value: string | null, rand: () => number, base: number) {
  const jitter = rand();
  const confidence = jitter > 0.7 ? Math.round((0.45 + jitter * 0.35) * 100) / 100 : base;
  return { value, confidence: Math.min(0.99, confidence) };
}

function seededRandom(seed: string): () => number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  return () => {
    h = (Math.imul(h ^ (h >>> 15), 1 | h) + 0x6d2b79f5) | 0;
    let t = (h ^= h >>> 7) >>> 0;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
