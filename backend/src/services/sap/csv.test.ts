import { describe, expect, it } from 'vitest';
import { buildOutboundPayload, csvEscape, outboundBaseName } from './csv.js';
import type { HeaderWithLines } from '../../domain/validation.js';

const header = (over: Partial<HeaderWithLines> = {}): HeaderWithLines =>
  ({
    id: 'h1',
    recordId: 'r1',
    poNumber: 'PO-1',
    poDate: '2026-09-01',
    customerName: 'Acme, Inc.',
    customerCode: 'C-1',
    shipTo: 'Line one\nLine two',
    billTo: 'He said "hello"',
    requestedDeliveryDate: '2026-10-01',
    currency: 'EUR',
    paymentTerms: 'Net 30',
    incoterms: 'DAP',
    poTotalValue: '50.00',
    contact: null,
    updatedAt: new Date(),
    lineItems: [
      {
        id: 'l2', headerId: 'h1', lineNumber: 2, materialCode: 'MAT-2', customerMaterialNumber: null,
        description: 'Second', quantity: '1', uom: 'EA', unitPrice: '25.00', lineNetValue: '25.00',
        deliveryDate: null, plant: null,
      },
      {
        id: 'l1', headerId: 'h1', lineNumber: 1, materialCode: 'MAT-1', customerMaterialNumber: null,
        description: 'First', quantity: '1', uom: 'EA', unitPrice: '25.00', lineNetValue: '25.00',
        deliveryDate: null, plant: null,
      },
    ],
    ...over,
  }) as HeaderWithLines;

describe('outbound CSV (FR-9, §8.2)', () => {
  it('FR-9.4: escapes delimiters, quotes and newlines inside values', () => {
    expect(csvEscape('Acme, Inc.')).toBe('"Acme, Inc."');
    expect(csvEscape('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvEscape('a\nb')).toBe('a b');
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape(null)).toBe('');
  });

  it('FR-8.3: embeds the correlation ID in the filename', () => {
    expect(outboundBaseName('PO-ABC', 2)).toBe('PO_PO-ABC_2');
  });

  it('IC-06: every row carries the correlation ID so a line can never be orphaned', () => {
    const { files } = buildOutboundPayload('PO-ABC', 1, header());
    for (const file of files) {
      const rows = file.content.split('\n').filter((l) => l.trim());
      for (const row of rows) expect(row).toContain('PO-ABC');
    }
  });

  it('writes one H row and one L row per line item, lines in order', () => {
    const { files } = buildOutboundPayload('PO-ABC', 1, header());
    const rows = files[0]!.content.split('\n').filter((l) => l.trim());
    expect(rows.filter((r) => r.startsWith('H,'))).toHaveLength(1);
    const lines = rows.filter((r) => r.startsWith('L,'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('MAT-1');
    expect(lines[1]).toContain('MAT-2');
  });

  it('a multi-line address never splits a record across physical lines', () => {
    // A legacy line-by-line reader on the SAP side would otherwise see a truncated
    // record followed by a garbage one.
    const { files } = buildOutboundPayload('PO-ABC', 1, header());
    const rows = files[0]!.content.split('\n').filter((l) => l.trim());
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => /^[HL],/.test(r))).toBe(true);
    expect(files[0]!.content).toContain('Line one Line two');
  });
});
