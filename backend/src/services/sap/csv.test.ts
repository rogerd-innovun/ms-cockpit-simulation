import { describe, expect, it } from 'vitest';
import { OutboundFormatError, buildOutboundPayload, csvEscape, outboundBaseName, type CsvFormat } from './csv.js';
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

describe('outbound formats (FR-5.8, FR-9.4)', () => {
  const iso: CsvFormat = { dateFormat: 'iso', decimalSeparator: '.' };
  // What the model returns for the sample POs: each vendor writes dates and money its own way.
  const vendorStyle = () =>
    header({
      poDate: 'SEP 17, 2026',
      requestedDeliveryDate: '24 September 2026',
      poTotalValue: '1,599.50',
      currency: ' usd ',
      lineItems: [
        {
          id: 'l1', headerId: 'h1', lineNumber: 1, materialCode: 'MAT-1', customerMaterialNumber: null,
          description: 'First', quantity: '750', uom: 'EA', unitPrice: '0,42', lineNetValue: '1.234,50',
          deliveryDate: '18/09/2026', plant: null,
        },
      ],
    });
  const rows = (fmt: CsvFormat) =>
    buildOutboundPayload('PO-ABC', 1, vendorStyle(), fmt).files[0]!.content.split('\n').filter((l) => l.trim());

  it('sends one date form and plain decimals whatever the PO wrote', () => {
    const [h, l] = rows(iso);
    expect(h).toBe('H,PO-ABC,1,PO-1,2026-09-17,C-1,"Acme, Inc.",Line one Line two,"He said ""hello""",USD,2026-09-24,Net 30,DAP,1599.50');
    expect(l).toBe('L,PO-ABC,1,1,MAT-1,,First,750,EA,0.42,1234.50,2026-09-18,');
  });

  it('honours the configured date form', () => {
    expect(rows({ ...iso, dateFormat: 'yyyymmdd' })[0]).toContain(',20260917,');
    expect(rows({ ...iso, dateFormat: 'dd.mm.yyyy' })[0]).toContain(',17.09.2026,');
  });

  it('honours a decimal comma, quoting it so the delimiter stays unambiguous', () => {
    const [h, l] = rows({ ...iso, decimalSeparator: ',' });
    expect(h!.endsWith(',"1599,50"')).toBe(true);
    expect(l).toContain(',"0,42","1234,50",');
  });

  it('leaves blanks blank', () => {
    const { files } = buildOutboundPayload('PO-ABC', 1, header({ requestedDeliveryDate: null, poTotalValue: null }), iso);
    const h = files[0]!.content.split('\n')[0]!;
    expect(h).toContain(',EUR,,Net 30,DAP,');
    expect(h.endsWith(',DAP,')).toBe(true);
  });

  it('refuses to write a date or number it cannot read, rather than passing it through', () => {
    expect(() => buildOutboundPayload('PO-ABC', 1, header({ poDate: '09/18/2026' }), iso)).toThrow(OutboundFormatError);
    expect(() =>
      buildOutboundPayload(
        'PO-ABC', 1,
        header({ lineItems: [{ ...header().lineItems[0]!, quantity: 'lots' }] }),
        iso,
      ),
    ).toThrow(/Line 2 quantity/);
  });
});
