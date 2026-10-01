import { describe, expect, it } from 'vitest';
import { lineParamsSchema, listQuerySchema } from './query.js';

describe('worklist query', () => {
  it('accepts the parameters the UI sends', () => {
    expect(
      listQuerySchema.parse({ status: 'FAILED,EXTRACTION_FAILED', q: 'acme', mine: 'true', take: '50', skip: '100' }),
    ).toEqual({ status: ['FAILED', 'EXTRACTION_FAILED'], q: 'acme', mine: 'true', take: 50, skip: 100 });
  });

  it('treats absent and empty filters as no filter', () => {
    expect(listQuerySchema.parse({})).toEqual({});
    expect(listQuerySchema.parse({ status: '' }).status).toBeUndefined();
  });

  it('refuses a status that does not exist', () => {
    expect(() => listQuerySchema.parse({ status: 'BANANA' })).toThrow(/status/);
    expect(() => listQuerySchema.parse({ status: 'FAILED,BANANA' })).toThrow(/status/);
  });

  it.each([
    ['take', '-5'],
    ['take', '0'],
    ['take', 'abc'],
    ['take', '2.5'],
    ['skip', '-1'],
    ['skip', 'abc'],
  ])('refuses %s=%s', (key, value) => {
    expect(() => listQuerySchema.parse({ [key]: value })).toThrow(new RegExp(key));
  });

  it('refuses a repeated parameter rather than guessing which one was meant', () => {
    expect(() => listQuerySchema.parse({ status: ['FAILED', 'DRAFT'] })).toThrow();
  });

  it('leaves oversized pages to the service cap rather than refusing them', () => {
    expect(listQuerySchema.parse({ take: '9999' }).take).toBe(9999);
  });
});

describe('line number parameter', () => {
  it('reads a positive integer', () => {
    expect(lineParamsSchema.parse({ lineNumber: '3' }).lineNumber).toBe(3);
  });
  it.each(['abc', '0', '-2', '1.5', ''])('refuses "%s"', (v) => {
    expect(() => lineParamsSchema.parse({ lineNumber: v })).toThrow(/lineNumber/);
  });
});
