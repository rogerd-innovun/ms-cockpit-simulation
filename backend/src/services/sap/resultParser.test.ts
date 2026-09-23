import { describe, expect, it } from 'vitest';
import { ResultParseError, parseResultFile } from './resultParser.js';

const csv = (rows: string) =>
  `CORRELATION_ID,ATTEMPT,STATUS,SO_NUMBER,ERROR_CODE,ERROR_MESSAGE,SAP_TIMESTAMP\n${rows}\n`;

describe('SAP result parsing (FR-10.3, §8.3)', () => {
  it('reads a success result', () => {
    const r = parseResultFile('RESULT_PO-ABC_1.csv', csv('PO-ABC,1,SUCCESS,4500001234,,,2026-09-21T10:00:00Z'));
    expect(r).toMatchObject({ correlationId: 'PO-ABC', attempt: 1, outcome: 'SUCCESS', soNumber: '4500001234' });
  });

  it('reads a failure result with a quoted message containing the delimiter', () => {
    const r = parseResultFile(
      'RESULT_PO-ABC_2.csv',
      csv('PO-ABC,2,ERROR,,MATERIAL_NOT_FOUND,"Material MAT-1, plant 1000, not found",2026-09-21T10:00:00Z'),
    );
    expect(r.outcome).toBe('ERROR');
    expect(r.errorCode).toBe('MATERIAL_NOT_FOUND');
    expect(r.errorMessage).toBe('Material MAT-1, plant 1000, not found');
  });

  it('reads the JSON form (OQ-05 is still open)', () => {
    const r = parseResultFile(
      'RESULT_PO-ABC_1.json',
      JSON.stringify({ correlationId: 'PO-ABC', attempt: 1, status: 'SUCCESS', soNumber: '4500009999' }),
    );
    expect(r.soNumber).toBe('4500009999');
  });

  it('refuses a SUCCESS with no SO number rather than marking the record created', () => {
    expect(() => parseResultFile('r.csv', csv('PO-ABC,1,SUCCESS,,,,'))).toThrow(ResultParseError);
  });

  it('refuses a result with no correlation ID', () => {
    expect(() => parseResultFile('r.csv', csv(',1,SUCCESS,4500001234,,,'))).toThrow(ResultParseError);
  });

  it('refuses an unrecognised status rather than guessing', () => {
    expect(() => parseResultFile('r.csv', csv('PO-ABC,1,MAYBE,4500001234,,,'))).toThrow(/SUCCESS or ERROR/);
  });

  it('refuses empty and truncated files', () => {
    expect(() => parseResultFile('r.csv', '')).toThrow(ResultParseError);
    expect(() => parseResultFile('r.csv', 'CORRELATION_ID,ATTEMPT,STATUS\n')).toThrow(ResultParseError);
  });

  it('tolerates columns in a different order', () => {
    const r = parseResultFile('r.csv', 'STATUS,SO_NUMBER,CORRELATION_ID,ATTEMPT\nSUCCESS,4500005555,PO-XYZ,3\n');
    expect(r).toMatchObject({ correlationId: 'PO-XYZ', attempt: 3, soNumber: '4500005555' });
  });
});
