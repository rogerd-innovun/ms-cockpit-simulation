import { HEADER_FIELDS, HEADER_LABELS, LINE_FIELDS, LINE_LABELS } from '../../domain/types.js';

/** Bumped whenever the prompt text changes; stored on every run (FR-4.4). */
export const GENERIC_PROMPT_VERSION = 'generic-v1';

const headerFieldList = HEADER_FIELDS.map((f) => `  - ${f} (${HEADER_LABELS[f]})`).join('\n');
const lineFieldList = LINE_FIELDS.map((f) => `  - ${f} (${LINE_LABELS[f]})`).join('\n');

/**
 * FR-4.3 — the fallback used when no vendor profile matches the document.
 *
 * The confidence instruction is the load-bearing part: a model that reports 0.99 on a
 * value it guessed defeats the entire review screen, so the prompt is explicit that
 * confidence describes legibility and certainty, not plausibility.
 */
export const GENERIC_EXTRACTION_PROMPT = `You are extracting structured data from a customer Purchase Order (PO) document so that a Sales Order can be created in SAP S/4HANA.

Extract the following HEADER fields (one set per document):
${headerFieldList}

Extract the following fields for EACH LINE ITEM on the order:
${lineFieldList}

Rules:
1. Return values exactly as they appear in the document. Do not reformat numbers, dates or codes. If the document says "1.234,56", return "1.234,56".
2. If a field is not present in the document, return null for its value. Never invent, infer or complete a value that is not written on the page.
3. Number every line item sequentially starting at 1, in the order they appear. If the document prints its own line numbers, use those.
4. Include every line item, including ones that continue across a page break. Do not merge or split lines.
5. Ignore totals, subtotals, tax rows, freight rows and notes when building lineItems — those are not ordered materials. Put the order total in the header field poTotalValue.

Confidence scoring — this is critical:
- Report a confidence between 0.0 and 1.0 for every field, including fields you return as null.
- Confidence must reflect how certain you are that you read the document correctly: character legibility, label ambiguity, and whether the value was clearly labelled.
- Use a LOW confidence (below 0.85) whenever the text was blurred, handwritten, ambiguous, split across lines, or when you had to choose between two candidate values on the page.
- Do not report high confidence because a value looks plausible. A plausible guess must score low. A human reviews every low-confidence field before this reaches SAP, so an honest low score is far more useful than a confident wrong one.
- For a field that is genuinely absent from the document, return value null with a high confidence (you are confident it is not there).

Also report which vendor or customer issued this PO in the "vendorIdentified" field, if their name is visible.`;

/** FR-4.1 — a vendor profile supplies its own prompt; this frames it consistently. */
export function buildVendorPrompt(vendorName: string, vendorPrompt: string): string {
  return `${GENERIC_EXTRACTION_PROMPT}

---
This document is expected to be a Purchase Order from "${vendorName}". The following notes describe that vendor's specific layout. Follow them where they apply, and fall back to the general rules above where they do not:

${vendorPrompt}`;
}
