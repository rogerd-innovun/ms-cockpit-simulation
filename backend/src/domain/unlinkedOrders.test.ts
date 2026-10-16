import { describe, expect, it } from 'vitest';
import { unlinkedOrders, type ResultLike } from './unlinkedOrders.js';

const at = new Date('2026-10-04T10:00:00Z');
const result = (over: Partial<ResultLike>): ResultLike => ({
  outcome: 'SUCCESS', soNumber: '4500000001', attempt: 1, quarantined: false, ingestedAt: at, sapTimestamp: null, ...over,
});

describe('unlinkedOrders', () => {
  it('is empty when the only order SAP created is the one the record holds', () => {
    expect(unlinkedOrders('4500000001', [result({})])).toEqual([]);
  });

  it('reports an order SAP created for an attempt the record has moved past', () => {
    const out = unlinkedOrders('4500000002', [
      result({ attempt: 1, soNumber: '4500000001' }),
      result({ attempt: 2, soNumber: '4500000002' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ soNumber: '4500000001', attempt: 1 });
  });

  it('reports every created order when the record is linked to none', () => {
    const out = unlinkedOrders(null, [result({ soNumber: '4500000001' }), result({ soNumber: '4500000009', attempt: 2 })]);
    expect(out.map((o) => o.soNumber)).toEqual(['4500000001', '4500000009']);
  });

  it('ignores rejections, quarantined files and results with no number', () => {
    expect(
      unlinkedOrders(null, [
        result({ outcome: 'ERROR', soNumber: null }),
        result({ quarantined: true }),
        result({ soNumber: null }),
      ]),
    ).toEqual([]);
  });

  it('treats a zero-padded number as the same order', () => {
    expect(unlinkedOrders('0004500000001', [result({ soNumber: '4500000001' })])).toEqual([]);
    expect(unlinkedOrders('4500000001', [result({ soNumber: '0004500000001' })])).toEqual([]);
  });

  it('reports one order once, however many files named it', () => {
    expect(unlinkedOrders(null, [result({}), result({})])).toHaveLength(1);
  });
});
