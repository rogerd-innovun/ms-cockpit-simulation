import { describe, expect, it } from 'vitest';
import { blockingIssues, parseDate, parseDecimal, validateRecord, type HeaderWithLines } from './validation.js';

const line = (over: Partial<HeaderWithLines['lineItems'][number]> = {}) =>
  ({
    id: 'l1',
    headerId: 'h1',
    lineNumber: 1,
    materialCode: 'MAT-1',
    customerMaterialNumber: null,
    description: 'Widget',
    quantity: '10',
    uom: 'EA',
    unitPrice: '5.00',
    lineNetValue: '50.00',
    deliveryDate: null,
    plant: null,
    ...over,
  }) as HeaderWithLines['lineItems'][number];

const header = (over: Partial<HeaderWithLines> = {}): HeaderWithLines =>
  ({
    id: 'h1',
    recordId: 'r1',
    poNumber: 'PO-1',
    poDate: '2026-09-01',
    customerName: 'Acme',
    customerCode: 'C-1',
    shipTo: null,
    billTo: null,
    requestedDeliveryDate: '2026-10-01',
    currency: 'EUR',
    paymentTerms: null,
    incoterms: null,
    poTotalValue: '50.00',
    contact: null,
    updatedAt: new Date(),
    lineItems: [line()],
    ...over,
  }) as HeaderWithLines;

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('number parsing (FR-5.8)', () => {
  it('reads both European and US conventions', () => {
    expect(parseDecimal('1.234,56')).toBeCloseTo(1234.56);
    expect(parseDecimal('1,234.56')).toBeCloseTo(1234.56);
    expect(parseDecimal('1234.56')).toBeCloseTo(1234.56);
    expect(parseDecimal('1234,56')).toBeCloseTo(1234.56);
    expect(parseDecimal('EUR 1.000,00')).toBeCloseTo(1000);
  });

  it('returns null rather than guessing on unreadable input', () => {
    expect(parseDecimal('abc')).toBeNull();
    expect(parseDecimal(null)).toBeNull();
    expect(parseDecimal('')).toBeNull();
  });
});

describe('date parsing', () => {
  it('reads ISO and DD.MM.YYYY / DD/MM/YYYY', () => {
    expect(parseDate('2026-09-21')?.toISOString().slice(0, 10)).toBe('2026-09-21');
    expect(parseDate('21.09.2026')?.toISOString().slice(0, 10)).toBe('2026-09-21');
    expect(parseDate('21/09/2026')?.toISOString().slice(0, 10)).toBe('2026-09-21');
  });
  it('rejects nonsense', () => {
    expect(parseDate('not-a-date')).toBeNull();
  });
});

describe('validation (FR-6)', () => {
  it('passes a well-formed order', async () => {
    expect(await validateRecord(header())).toEqual([]);
  });

  it('blocks a record with no extracted data at all', async () => {
    expect(codes(await validateRecord(null))).toContain('NO_DATA');
  });

  it('FR-6.2: blocks missing required header fields', async () => {
    const issues = await validateRecord(header({ customerCode: null, poNumber: '  ' }));
    expect(codes(issues).filter((c) => c === 'REQUIRED_MISSING')).toHaveLength(2);
    expect(blockingIssues(issues).length).toBeGreaterThan(0);
  });

  it('FR-6.2: blocks a non-ISO currency', async () => {
    expect(codes(await validateRecord(header({ currency: 'EURO' })))).toContain('INVALID_CURRENCY');
  });

  it('FR-6.2: blocks a zero or negative quantity', async () => {
    expect(codes(await validateRecord(header({ lineItems: [line({ quantity: '0' })] })))).toContain(
      'QUANTITY_NOT_POSITIVE',
    );
    expect(codes(await validateRecord(header({ lineItems: [line({ quantity: '-1' })] })))).toContain(
      'QUANTITY_NOT_POSITIVE',
    );
  });

  it('FR-6.2: blocks an order with no line items', async () => {
    expect(codes(await validateRecord(header({ lineItems: [] })))).toContain('NO_LINE_ITEMS');
  });

  it('FR-6.6: warns when line arithmetic does not reconcile', async () => {
    const issues = await validateRecord(
      header({ lineItems: [line({ lineNetValue: '999.00' })], poTotalValue: '999.00' }),
    );
    expect(codes(issues)).toContain('LINE_MATH_MISMATCH');
    expect(issues.find((i) => i.code === 'LINE_MATH_MISMATCH')?.severity).toBe('WARNING');
  });

  it('FR-6.6: warns when the header total does not match the sum of lines', async () => {
    const issues = await validateRecord(header({ poTotalValue: '500.00' }));
    expect(codes(issues)).toContain('TOTAL_MISMATCH');
    expect(blockingIssues(issues)).toHaveLength(0);
  });

  it('FR-6.1: a warning never blocks approval on its own', async () => {
    const issues = await validateRecord(header({ requestedDeliveryDate: '2026-08-01' }));
    expect(codes(issues)).toContain('DELIVERY_BEFORE_PO_DATE');
    expect(blockingIssues(issues)).toHaveLength(0);
  });

  it('FR-6.3: flags unknown customer and material when master data is available', async () => {
    const masterData = {
      customerExists: async () => false,
      materialExists: async () => false,
      normaliseUom: async () => ({ valid: true }),
    };
    const issues = await validateRecord(header(), masterData);
    expect(codes(issues)).toContain('UNKNOWN_CUSTOMER');
    expect(codes(issues)).toContain('UNKNOWN_MATERIAL');
    expect(blockingIssues(issues)).toHaveLength(2);
  });
});
