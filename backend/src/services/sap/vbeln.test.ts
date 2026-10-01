import { describe, expect, it } from 'vitest';
import { VbelnError, toVbeln } from './vbeln.js';

describe('toVbeln (CHAR10, ALPHA conversion)', () => {
  it('passes a full ten-digit S/4HANA number through unchanged', () => {
    expect(toVbeln('4500123456')).toBe('4500123456');
  });

  it('left-pads a short numeric number with zeros, as SAP stores it', () => {
    expect(toVbeln('12345')).toBe('0000012345');
    expect(toVbeln('  12345 ')).toBe('0000012345');
  });

  it('keeps an alphanumeric number left-aligned and upper-cased', () => {
    expect(toVbeln('so12345')).toBe('SO12345');
  });

  it('refuses a number longer than ten characters rather than truncating it', () => {
    expect(() => toVbeln('45001234567')).toThrow(VbelnError);
  });

  it('refuses an empty number and characters VBELN cannot hold', () => {
    expect(() => toVbeln(null)).toThrow(VbelnError);
    expect(() => toVbeln('   ')).toThrow(VbelnError);
    expect(() => toVbeln('SO-123')).toThrow(VbelnError);
  });
});
