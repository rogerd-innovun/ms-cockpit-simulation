import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GENERIC_EXTRACTION_PROMPT, GENERIC_PROMPT_VERSION, buildVendorPrompt } from './prompts.js';

describe('generic extraction prompt (FR-4.4)', () => {
  // The prompt version is stored on every extraction run, so that "which prompt read this?"
  // always has an answer. That only holds if the version moves whenever the text does.
  // If this fails you have edited the prompt: bump GENERIC_PROMPT_VERSION, then put the new
  // hash here.
  it('has a version that goes with its exact text', () => {
    const hash = createHash('sha256').update(GENERIC_EXTRACTION_PROMPT).digest('hex').slice(0, 16);
    expect({ version: GENERIC_PROMPT_VERSION, hash }).toEqual({ version: 'generic-v2', hash: 'c7bba28b91898e95' });
  });

  it('tells the model which total is the PO total', () => {
    expect(GENERIC_EXTRACTION_PROMPT).toMatch(/BEFORE tax/);
    expect(GENERIC_EXTRACTION_PROMPT).toMatch(/Total HT/);
    expect(GENERIC_EXTRACTION_PROMPT).toMatch(/never the grand total/);
    expect(GENERIC_EXTRACTION_PROMPT).toMatch(/do not add up, subtract or calculate/);
  });

  it('still says to use the net price when a line shows a list price and a discount', () => {
    expect(GENERIC_EXTRACTION_PROMPT).toMatch(/NET price/);
  });

  it('is carried unchanged into a vendor prompt', () => {
    expect(buildVendorPrompt('Acme', '- notes')).toContain(GENERIC_EXTRACTION_PROMPT);
  });
});
