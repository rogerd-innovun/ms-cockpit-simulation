import { describe, expect, it } from 'vitest';
import { normaliseDecimal, parseDecimal } from './decimal';

// The cases below are the ones backend/src/domain/validation.test.ts uses for the server's
// reader. If one side changes, change both: the screen's sums and sorting must agree with
// what the validator and the CSV already made of the same text.

describe('normaliseDecimal (same rule as the server)', () => {
  it('reads both conventions and the grouping marks vendors use', () => {
    expect(normaliseDecimal('1,599.50')).toBe('1599.50');
    expect(normaliseDecimal('1.234,56')).toBe('1234.56');
    expect(normaliseDecimal('1 234,56')).toBe('1234.56');
    expect(normaliseDecimal("1'234.56")).toBe('1234.56');
    expect(normaliseDecimal('1,23,456.78')).toBe('123456.78'); // lakh grouping
    expect(normaliseDecimal('USD 42')).toBe('42');
    expect(normaliseDecimal('-5,5')).toBe('-5.5');
    expect(normaliseDecimal('.5')).toBe('0.5');
  });

  it('a separator that repeats on its own is grouping', () => {
    expect(normaliseDecimal('1.234.567')).toBe('1234567');
    expect(normaliseDecimal('1,234,567')).toBe('1234567');
  });

  it('says null rather than guessing', () => {
    expect(normaliseDecimal('abc')).toBeNull();
    expect(normaliseDecimal('10-20')).toBeNull();
    expect(normaliseDecimal('1,2.3,4')).toBeNull();
    expect(normaliseDecimal('')).toBeNull();
    expect(normaliseDecimal(null)).toBeNull();
    expect(normaliseDecimal(undefined)).toBeNull();
  });
});

describe('parseDecimal', () => {
  it('gives the number the text means', () => {
    expect(parseDecimal('1.234,56')).toBeCloseTo(1234.56);
    expect(parseDecimal('1,234.56')).toBeCloseTo(1234.56);
    expect(parseDecimal('EUR 1.000,00')).toBeCloseTo(1000);
  });

  it('adds up a European PO correctly (the bug: "1 260,00" used to be read as 126000)', () => {
    // po-bondecommande.pdf: the four line values as the French page prints them.
    const lines = ['1 260,00', '1 183,00', '1 056,00', '1 098,75'];
    const sum = lines.reduce((s, l) => s + (parseDecimal(l) ?? 0), 0);
    expect(sum).toBeCloseTo(4597.75);
  });

  it('adds up an Indian PO with lakh grouping and a US PO the same way', () => {
    expect(['12,34,567.89', '1,23,456.78'].reduce((s, l) => s + (parseDecimal(l) ?? 0), 0)).toBeCloseTo(1358024.67);
    expect(['1,299.00', '3,643.00'].reduce((s, l) => s + (parseDecimal(l) ?? 0), 0)).toBeCloseTo(4942);
  });

  it('is null for text that is not a number, so a sort or a sum can skip it', () => {
    expect(parseDecimal('per agreement')).toBeNull();
    expect(parseDecimal(null)).toBeNull();
  });
});
