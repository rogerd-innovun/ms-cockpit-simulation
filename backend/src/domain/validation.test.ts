import { describe, expect, it } from 'vitest';
import {
  blockingIssues,
  documentProvesDayFirst,
  formatDate,
  isAmbiguousDate,
  isAmbiguousDecimal,
  normaliseDecimal,
  parseDate,
  parseDecimal,
  validateRecord,
  type HeaderWithLines,
} from './validation.js';

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

describe('canonical numbers (FR-5.8, sent to SAP)', () => {
  it('writes plain digits with a "." decimal point, keeping the fraction as written', () => {
    expect(normaliseDecimal('1,599.50')).toBe('1599.50');
    expect(normaliseDecimal('1.234,56')).toBe('1234.56');
    expect(normaliseDecimal('1 234,56')).toBe('1234.56');
    expect(normaliseDecimal("1'234.56")).toBe('1234.56');
    expect(normaliseDecimal('1,23,456.78')).toBe('123456.78'); // lakh grouping
    expect(normaliseDecimal('USD 42')).toBe('42');
    expect(normaliseDecimal('-5,5')).toBe('-5.5');
    expect(normaliseDecimal('.5')).toBe('0.5');
  });

  it('reads a separator that repeats on its own as grouping', () => {
    expect(normaliseDecimal('1.234.567')).toBe('1234567');
    expect(normaliseDecimal('1,234,567')).toBe('1234567');
  });

  it('returns null for anything that is not one number', () => {
    expect(normaliseDecimal('abc')).toBeNull();
    expect(normaliseDecimal('10-20')).toBeNull();
    expect(normaliseDecimal('1,2.3,4')).toBeNull();
    expect(normaliseDecimal('')).toBeNull();
  });

  it('flags a lone separator with three digits after it as ambiguous', () => {
    expect(isAmbiguousDecimal('1,234')).toBe(true);
    expect(isAmbiguousDecimal('1.234')).toBe(true);
    expect(isAmbiguousDecimal('0,125')).toBe(false);
    expect(isAmbiguousDecimal('1,234.56')).toBe(false);
    expect(isAmbiguousDecimal('1234,567')).toBe(false);
    expect(isAmbiguousDecimal('12,34')).toBe(false);
  });
});

describe('date parsing', () => {
  const iso = (s: string) => parseDate(s)?.toISOString().slice(0, 10);

  it('reads ISO and DD.MM.YYYY / DD/MM/YYYY', () => {
    expect(iso('2026-09-21')).toBe('2026-09-21');
    expect(iso('21.09.2026')).toBe('2026-09-21');
    expect(iso('21/09/2026')).toBe('2026-09-21');
  });

  it('reads the other forms the sample POs and the model actually produce', () => {
    expect(iso('SEP 17, 2026')).toBe('2026-09-17');
    expect(iso('Sep 18, 2026')).toBe('2026-09-18');
    expect(iso('24 September 2026')).toBe('2026-09-24');
    expect(iso('September 17, 2026')).toBe('2026-09-17');
    expect(iso('17-SEP-2026')).toBe('2026-09-17');
    expect(iso('Fri, 18 Sep 2026')).toBe('2026-09-18');
    expect(iso('Sept 18th 2026')).toBe('2026-09-18');
    expect(iso('2026/09/18')).toBe('2026-09-18');
    expect(iso('20260918')).toBe('2026-09-18');
    expect(iso('2026-09-18T10:00:00Z')).toBe('2026-09-18');
  });

  it('rejects impossible dates instead of rolling them into the next month', () => {
    expect(parseDate('09/18/2026')).toBeNull(); // month 18: a US date, not a day-first one
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('2026-02-30')).toBeNull();
    expect(parseDate('Sep 31 2026')).toBeNull();
  });

  it('rejects nonsense', () => {
    expect(parseDate('not-a-date')).toBeNull();
    expect(parseDate('17 2026 2026')).toBeNull();
    expect(parseDate('Sep 2026')).toBeNull();
  });

  it('flags a numeric date that reads differently month-first', () => {
    expect(isAmbiguousDate('03/04/2026')).toBe(true);
    expect(isAmbiguousDate('18/09/2026')).toBe(false);
    expect(isAmbiguousDate('05/05/2026')).toBe(false);
    expect(isAmbiguousDate('Sep 18, 2026')).toBe(false);
  });

  it('a date above 12 in the first place proves the document writes day first', () => {
    expect(documentProvesDayFirst(['18/09/2026'])).toBe(true);
    expect(documentProvesDayFirst(['05/10/2026', null, '2026-10-01', '31.12.2026'])).toBe(true);
    expect(documentProvesDayFirst(['05/10/2026', '03/04/2026'])).toBe(false);
    expect(documentProvesDayFirst(['09/18/2026'])).toBe(false); // month 18: not day first at all
    expect(documentProvesDayFirst([null, undefined, 'Sep 18, 2026'])).toBe(false);
  });

  it('formats in each configured form', () => {
    const d = parseDate('17 Sep 2026')!;
    expect(formatDate(d, 'iso')).toBe('2026-09-17');
    expect(formatDate(d, 'yyyymmdd')).toBe('20260917');
    expect(formatDate(d, 'dd.mm.yyyy')).toBe('17.09.2026');
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

  it('blocks a date that is impossible rather than reading it as something else', async () => {
    const issues = await validateRecord(header({ poDate: '09/18/2026' }));
    expect(issues.find((i) => i.code === 'INVALID_DATE')?.severity).toBe('BLOCKING');
  });

  it('blocks unreadable line dates and non-numeric prices, totals and net values', async () => {
    const issues = await validateRecord(
      header({
        poTotalValue: 'n/a',
        lineItems: [line({ deliveryDate: 'soon', unitPrice: 'TBD', lineNetValue: 'ask' })],
      }),
    );
    const blocking = issues.filter((i) => i.severity === 'BLOCKING').map((i) => `${i.code}@${i.fieldPath}`);
    expect(blocking).toContain('INVALID_DATE@line.1.deliveryDate');
    expect(blocking).toContain('INVALID_NUMBER@line.1.unitPrice');
    expect(blocking).toContain('INVALID_NUMBER@line.1.lineNetValue');
    expect(blocking).toContain('INVALID_NUMBER@header.poTotalValue');
  });

  it('warns, without blocking, on a day-first date and on a 1,000-or-1.000 quantity', async () => {
    const issues = await validateRecord(
      header({
        poDate: '03/04/2026',
        requestedDeliveryDate: '2026-10-01',
        lineItems: [line({ quantity: '1,000', unitPrice: '5.00', lineNetValue: '5.00' })],
        poTotalValue: '5.00',
      }),
    );
    expect(codes(issues)).toContain('AMBIGUOUS_DATE');
    expect(codes(issues)).toContain('AMBIGUOUS_NUMBER');
    expect(blockingIssues(issues)).toHaveLength(0);
  });

  it('does not ask about an ambiguous date when another date on the order proves the format', async () => {
    // 18/09 can only be day first, so 05/10 on the same page is 5 October, not 10 May.
    const proven = await validateRecord(
      header({
        poDate: '18/09/2026',
        requestedDeliveryDate: '05/10/2026',
        lineItems: [line({ deliveryDate: '12/10/2026' })],
      }),
    );
    expect(codes(proven)).not.toContain('AMBIGUOUS_DATE');

    // With nothing to go on, each such date is a question.
    const unproven = await validateRecord(
      header({ poDate: '03/04/2026', requestedDeliveryDate: '05/10/2026', lineItems: [line({ deliveryDate: '12/10/2026' })] }),
    );
    expect(unproven.filter((i) => i.code === 'AMBIGUOUS_DATE').map((i) => i.fieldPath)).toEqual([
      'header.poDate',
      'header.requestedDeliveryDate',
      'line.1.deliveryDate',
    ]);
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
