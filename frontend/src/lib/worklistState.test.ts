import { describe, expect, it } from 'vitest';
import { DEFAULT_SORT, readWorklist, writeWorklist, type WorklistState } from './worklistState';

const VIEWS = ['all', 'review', 'failed', 'inflight', 'draft', 'done', 'mine'];
const read = (qs: string) => readWorklist(new URLSearchParams(qs), VIEWS);

describe('worklist state in the URL', () => {
  it('an empty query string is the plain list: All, no search, newest first', () => {
    expect(read('')).toEqual({ view: 'all', q: '', sort: DEFAULT_SORT });
    expect(writeWorklist(read('')).toString()).toBe('');
  });

  it('round-trips a view, a search and a sort', () => {
    const state: WorklistState = { view: 'review', q: 'apex fastener', sort: { key: 'value', dir: 1 } };
    const qs = writeWorklist(state).toString();
    expect(qs).toBe('view=review&q=apex+fastener&sort=value&dir=asc');
    expect(read(qs)).toEqual(state);
  });

  it('keeps a descending sort on another column', () => {
    const state: WorklistState = { view: 'all', q: '', sort: { key: 'customer', dir: -1 } };
    expect(read(writeWorklist(state).toString())).toEqual(state);
  });

  it('leaves out whatever is the default, including the default sort', () => {
    expect(writeWorklist({ view: 'all', q: '', sort: { key: 'age', dir: -1 } }).toString()).toBe('');
    // Oldest first is not the default, so it is written.
    expect(writeWorklist({ view: 'all', q: '', sort: { key: 'age', dir: 1 } }).toString()).toBe('sort=age&dir=asc');
  });

  it('ignores a view or sort it does not know instead of showing an empty page', () => {
    expect(read('view=nonsense&sort=bogus&dir=sideways')).toEqual({ view: 'all', q: '', sort: DEFAULT_SORT });
  });

  it('reads a column with no direction as ascending, and age as newest first', () => {
    expect(read('sort=poNumber').sort).toEqual({ key: 'poNumber', dir: 1 });
    expect(read('sort=age').sort).toEqual({ key: 'age', dir: -1 });
  });

  it('does not store a search that is only spaces', () => {
    expect(writeWorklist({ view: 'all', q: '   ', sort: DEFAULT_SORT }).toString()).toBe('');
  });
});
