/**
 * Reading a number the way the server does, for the places the screen has to add things up
 * or sort by them. PO amounts arrive as the vendor wrote them — "1.234,56", "1 234,56",
 * "1,234.56", "12,34,567.89" — and the cockpit keeps them as written, so anything that
 * computes from them has to read them as the validator does. Stripping everything but
 * digits and "." made "1 260,00" come out as 126000.
 *
 * This is the same rule as `normaliseDecimal` in backend/src/domain/validation.ts, kept in
 * step by decimal.test.ts: the decimal separator is whichever of "," and "." appears last;
 * a separator that repeats on its own can only be grouping; anything unreadable is null,
 * never a guess.
 */
export function normaliseDecimal(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = raw.replace(/[^\d,.\-]/g, '');
  if (!s) return null;
  const negative = s.startsWith('-');
  const body = negative ? s.slice(1) : s;
  if (body.includes('-')) return null;

  const count = (ch: string) => body.split(ch).length - 1;
  const commas = count(',');
  const dots = count('.');

  let out: string;
  if (commas === 0 && dots === 0) out = body;
  else if (commas > 0 && dots > 0) {
    const decimal = body.lastIndexOf(',') > body.lastIndexOf('.') ? ',' : '.';
    const group = decimal === ',' ? '.' : ',';
    if (count(decimal) !== 1) return null;
    out = body.split(group).join('').replace(decimal, '.');
  } else {
    const sep = commas > 0 ? ',' : '.';
    out = commas + dots === 1 ? body.replace(sep, '.') : body.split(sep).join('');
  }

  if (out.startsWith('.')) out = `0${out}`;
  if (out.endsWith('.')) out = out.slice(0, -1);
  if (!/^\d+(\.\d+)?$/.test(out)) return null;
  return negative ? `-${out}` : out;
}

export function parseDecimal(raw: string | null | undefined): number | null {
  const n = normaliseDecimal(raw);
  return n === null ? null : Number(n);
}
