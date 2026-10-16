/**
 * Where the worklist is "standing": which view, what search, how sorted. It lives in the
 * URL (/?view=review&q=apex&sort=value&dir=asc) rather than in the page's memory, so that
 * opening a record and coming back — by Back, by the Worklist link, by a reload — lands on
 * the same list instead of on "All, newest first". Defaults are left out of the URL, so the
 * plain address is still the plain list.
 */

export const SORT_KEYS = ['status', 'poNumber', 'customer', 'lines', 'value', 'soNumber', 'age'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export interface WorklistState {
  view: string;
  q: string;
  sort: { key: SortKey; dir: 1 | -1 };
}

export const DEFAULT_VIEW = 'all';
export const DEFAULT_SORT: WorklistState['sort'] = { key: 'age', dir: -1 };

/** Reads the state from a query string, ignoring anything it does not recognise. */
export function readWorklist(params: URLSearchParams, views: readonly string[]): WorklistState {
  const view = params.get('view');
  const sortKey = params.get('sort');
  const dir = params.get('dir');
  const key: SortKey = (SORT_KEYS as readonly string[]).includes(sortKey ?? '') ? (sortKey as SortKey) : DEFAULT_SORT.key;
  return {
    view: view !== null && views.includes(view) ? view : DEFAULT_VIEW,
    q: params.get('q') ?? '',
    sort: {
      key,
      // Age is newest-first unless said otherwise; every other column starts ascending.
      dir: dir === 'asc' ? 1 : dir === 'desc' ? -1 : key === DEFAULT_SORT.key ? DEFAULT_SORT.dir : 1,
    },
  };
}

/** The query string for a state, with every default left out. */
export function writeWorklist(state: WorklistState): URLSearchParams {
  const p = new URLSearchParams();
  if (state.view !== DEFAULT_VIEW) p.set('view', state.view);
  if (state.q.trim()) p.set('q', state.q);
  if (state.sort.key !== DEFAULT_SORT.key || state.sort.dir !== DEFAULT_SORT.dir) {
    p.set('sort', state.sort.key);
    p.set('dir', state.sort.dir === 1 ? 'asc' : 'desc');
  }
  return p;
}

// ---- remembering the last list -------------------------------------------------------

const KEY = 'cockpit.worklist';

/** Called by the worklist whenever its state changes. Session storage may be unavailable. */
export function rememberWorklist(search: string): void {
  try {
    sessionStorage.setItem(KEY, search);
  } catch {
    /* private browsing — the worklist link just goes to the plain list */
  }
}

/** Where "Worklist" should lead: the list as it was last left, or the plain list. */
export function worklistHref(): string {
  try {
    const search = sessionStorage.getItem(KEY);
    return search ? `/?${search}` : '/';
  } catch {
    return '/';
  }
}
