/**
 * Minimal PDF writer shared by the sample-document generators.
 *
 * There is no PDF dependency anywhere in this project on purpose: the sample
 * documents exist so the lifecycle can be exercised without hunting for real
 * customer paperwork, and a generator that pulls a rendering engine into the
 * backend's dependency tree costs more than the documents are worth. Everything
 * here is a text-bearing single-page A4 sheet built from Helvetica Type1 fonts,
 * which every PDF reader (and Gemini) handles natively.
 *
 * Used by makeSamplePo.ts (inbound customer POs) and makeSampleSo.ts (outbound
 * order confirmations).
 */

export interface Row {
  text: string;
  size: number;
  bold: boolean;
  y: number;
  x: number;
  /** Courier instead of Helvetica — for documents that read as fixed-width ERP output. */
  mono?: boolean;
}

/**
 * Content is written as latin1 with /WinAnsiEncoding, so accented latin1 letters
 * (ä, ö, é) survive but typographic punctuation does NOT — an em dash or a curly
 * apostrophe silently truncates to a control byte. Keep sample text to ASCII plus
 * latin1 accents and the middle dot.
 */
export function escapePdf(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * A downward-running text cursor. `add` places a row and advances; passing an
 * explicit `y` places without advancing, which is how columns are written across
 * a single line.
 */
export function makeSheet() {
  const rows: Row[] = [];
  let y = 800;
  const add = (text: string, opts: Partial<Row> = {}) => {
    rows.push({
      text,
      size: opts.size ?? 9,
      bold: opts.bold ?? false,
      y: opts.y ?? y,
      x: opts.x ?? 50,
      ...(opts.mono ? { mono: true } : {}),
    });
    if (opts.y === undefined) y -= opts.size ? opts.size + 4 : 13;
  };
  return { rows, add, drop: (n: number) => { y -= n; }, at: () => y };
}

/**
 * Adobe's standard Helvetica advance widths, in 1/1000 em. Needed to right-align a
 * money column: without real metrics you can only left-align, and a ragged column of
 * figures is the first thing anyone notices on a printed document.
 */
const HELVETICA_WIDTHS: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333,
  '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, ':': 278, ';': 278, '<': 584, '=': 584,
  '>': 584, '?': 556, '@': 1015, '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  '{': 334, '|': 260, '}': 334, '~': 584, '·': 333,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556,
  M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667,
  Y: 667, Z: 611,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222,
  m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500,
  y: 500, z: 500,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
};

/** Rendered width of a string in points. Courier is fixed-width at 0.6 em. */
export function textWidth(text: string, size: number, opts: { bold?: boolean; mono?: boolean } = {}) {
  if (opts.mono) return text.length * 0.6 * size;
  let em = 0;
  for (const ch of text) em += (HELVETICA_WIDTHS[ch] ?? 556) / 1000;
  // Helvetica-Bold is marginally wider than the regular face; close enough for placement.
  return em * size * (opts.bold ? 1.05 : 1);
}

export function assemblePdf(objects: (string | Buffer)[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let length = parts[0]!.length;

  objects.forEach((obj, i) => {
    offsets.push(length);
    const body = Buffer.isBuffer(obj) ? obj : Buffer.from(obj, 'latin1');
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(chunk);
    length += chunk.length;
  });

  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) tail += `${String(off).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(tail, 'latin1'));

  return Buffer.concat(parts);
}

/**
 * The same sheets, several pages. A separate function rather than a change to
 * buildTextPdf, so the single-page documents already generated stay byte-for-byte
 * what they were. Helvetica and Helvetica-Bold only.
 */
export function buildMultiPagePdf(pages: Row[][]): Buffer {
  const contentOf = (rows: Row[]) =>
    rows
      .map((r) => `BT /${r.bold ? 'F2' : 'F1'} ${r.size} Tf 1 0 0 1 ${r.x} ${r.y} Tm (${escapePdf(r.text)}) Tj ET`)
      .join('\n');

  // Objects 1-4 are the catalogue, the page tree and the two fonts; each page then
  // takes two (the page, then its content stream).
  const pageObjectId = (i: number) => 5 + i * 2;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObjectId(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  pages.forEach((rows, i) => {
    const content = contentOf(rows);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageObjectId(i) + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    );
  });
  return assemblePdf(objects);
}

export function buildTextPdf(rows: Row[]): Buffer {
  // The Courier objects are emitted only when a row actually asks for them, so a
  // sheet that never uses mono produces exactly the bytes it did before the font
  // existed — the committed sample POs stay reproducible.
  const usesMono = rows.some((r) => r.mono);
  const fontOf = (r: Row) => (r.mono ? (r.bold ? 'F4' : 'F3') : r.bold ? 'F2' : 'F1');

  const content = rows
    .map((r) => `BT /${fontOf(r)} ${r.size} Tf 1 0 0 1 ${r.x} ${r.y} Tm (${escapePdf(r.text)}) Tj ET`)
    .join('\n');

  const fonts = usesMono ? '/F1 5 0 R /F2 6 0 R /F3 7 0 R /F4 8 0 R' : '/F1 5 0 R /F2 6 0 R';

  return assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << ${fonts} >> >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    ...(usesMono
      ? [
          '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
          '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>',
        ]
      : []),
  ]);
}
