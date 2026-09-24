/**
 * Generates realistic single-page PO PDFs with no PDF dependency, so the lifecycle can
 * be exercised without hunting for real customer documents. Five layouts are genuine
 * text-bearing PDFs (Gemini reads the text); `scan` is a rasterised fax-style page with
 * NO text layer at all, which proves the extractor reads pure images too.
 *
 *   npx tsx scripts/makeSamplePo.ts [outputPath] [--vendor=<key>]
 *
 * Vendors:
 *   northwind  UK trading company     GBP  DD/MM/YYYY   matches a seeded profile
 *   mock       German manufacturer    EUR  DD.MM.YYYY   matches a seeded profile
 *   apex       US industrial dist.    USD  "Sep 18, 2026"  matches a seeded profile
 *   shakti     Indian manufacturer    INR  DD-MM-YYYY (lakh grouping, GSTIN, HSN)  matches a seeded profile
 *   nordica    Swedish lab supplies   SEK  YYYY-MM-DD   no profile -> generic prompt
 *   scan       US metals fax (image)  USD  uppercase    no text layer -> vision only
 *   columns    Australian food dist.  AUD  DD/MM/YYYY   three header blocks side by side
 *   letter     Irish joinery          EUR  long dates   the whole PO is prose paragraphs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

interface Line {
  pos: number;
  code: string;
  customerCode: string;
  description: string;
  qty: number;
  uom: string;
  price: number;
}

const MATERIALS: Omit<Line, 'pos' | 'qty'>[] = [
  { code: 'MAT-1042', customerCode: 'CM-8801', description: 'Hex bolt M10x40 zinc plated', uom: 'EA', price: 0.42 },
  { code: 'MAT-2318', customerCode: 'CM-8802', description: 'Stainless washer DIN125 10mm', uom: 'EA', price: 0.11 },
  { code: 'MAT-5567', customerCode: 'CM-8803', description: 'Hydraulic hose assembly 1/2" 2m', uom: 'EA', price: 84.5 },
  { code: 'MAT-9021', customerCode: 'CM-8804', description: 'Industrial lubricant, 20L drum', uom: 'BOX', price: 132.0 },
  { code: 'MAT-3390', customerCode: 'CM-8805', description: 'Safety valve, 16 bar, DN25', uom: 'EA', price: 219.75 },
];

const VENDOR_KEYS = ['mock', 'northwind', 'apex', 'shakti', 'nordica', 'scan', 'columns', 'letter'] as const;
type VendorKey = (typeof VENDOR_KEYS)[number];

function escapePdf(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

type Row = { text: string; size: number; bold: boolean; y: number; x: number };

function makeSheet() {
  const rows: Row[] = [];
  let y = 800;
  const add = (text: string, opts: Partial<Row> = {}) => {
    rows.push({ text, size: opts.size ?? 9, bold: opts.bold ?? false, y: opts.y ?? y, x: opts.x ?? 50 });
    if (opts.y === undefined) y -= opts.size ? opts.size + 4 : 13;
  };
  return { rows, add, drop: (n: number) => { y -= n; }, at: () => y };
}

function pickLines(indices: number[], qtys: number[], priceFactor = 1): Line[] {
  return indices.map((mi, i) => ({
    ...MATERIALS[mi]!,
    price: Math.round(MATERIALS[mi]!.price * priceFactor * 100) / 100,
    pos: i + 1,
    qty: qtys[i]!,
  }));
}

// ------------------------------------------------------------------ layouts

function buildClassic(vendor: 'mock' | 'northwind'): { rows: Row[]; lines: Line[] } {
  const { rows, add, drop, at } = makeSheet();
  const lines: Line[] = MATERIALS.slice(0, 4).map((m, i) => ({
    ...m,
    pos: (i + 1) * 10,
    qty: [500, 1200, 6, 3][i]!,
  }));

  const german = vendor === 'mock';
  const money = (n: number) =>
    german
      ? n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const poNumber = german ? 'MI-2026-00847' : 'NW-884213';
  const poDate = german ? '18.09.2026' : '18/09/2026';
  const delivery = german ? '12.10.2026' : '12/10/2026';
  const vendorName = german ? 'Mock Industries GmbH' : 'Northwind Trading Ltd';
  const taxId = german ? 'DE123456789' : 'GB987654321';
  const customerCode = german ? 'C-2041' : 'C-7719';

  add(vendorName, { size: 16, bold: true });
  add(german ? 'Werkstrasse 14, 40213 Düsseldorf, Deutschland' : '22 Harbour Road, Bristol BS1 5TY, United Kingdom');
  add(german ? `USt-IdNr. ${taxId}` : `VAT Reg. ${taxId}`);
  drop(14);

  add(german ? 'BESTELLUNG / PURCHASE ORDER' : 'PURCHASE ORDER', { size: 14, bold: true });
  drop(6);

  add(german ? `Bestellnummer: ${poNumber}` : `Order Ref: ${poNumber}`, { bold: true });
  add(german ? `Bestelldatum: ${poDate}` : `Order Date: ${poDate}`);
  add(german ? `Lieferdatum: ${delivery}` : `Required By: ${delivery}`);
  add(german ? `Kundennummer: ${customerCode}` : `Account No: ${customerCode}`);
  add(german ? 'Währung: EUR' : 'Currency: GBP');
  add(german ? 'Zahlungsbedingungen: 30 Tage netto' : 'Payment Terms: Net 45');
  add(german ? 'Incoterms: DAP Düsseldorf' : 'Incoterms: FCA Bristol');
  drop(8);

  add(german ? 'Lieferadresse:' : 'Deliver To:', { bold: true });
  add(german ? 'Werk Nord, Tor 3, Industriestrasse 88, 40468 Düsseldorf' : 'Unit 7, Avonmouth Distribution Park, Bristol BS11 9YP');
  add(german ? 'Rechnungsadresse:' : 'Invoice To:', { bold: true });
  add(german ? 'Postfach 220, 40213 Düsseldorf' : 'Accounts Payable, 22 Harbour Road, Bristol BS1 5TY');
  drop(10);

  const cols = [50, 85, 150, 330, 385, 420, 480];
  const headers = german
    ? ['Pos.', 'Artikelnr.', 'Bezeichnung', 'Menge', 'ME', 'Preis', 'Betrag']
    : ['Line', 'Code', 'Description', 'Qty', 'UOM', 'Price', 'Amount'];
  headers.forEach((h, i) => add(h, { bold: true, x: cols[i], y: at() }));
  drop(4);
  add('_'.repeat(95), { size: 8 });
  drop(4);

  let total = 0;
  for (const line of lines) {
    const amount = line.qty * line.price;
    total += amount;
    const codeCell = german ? line.customerCode : line.code;
    const descCell = german ? `${line.description} (${line.code})` : line.description;
    const cells = [String(line.pos), codeCell, descCell, String(line.qty), line.uom, money(line.price), money(amount)];
    cells.forEach((c, i) => add(c, { x: cols[i], y: at() }));
    drop(14);
  }

  drop(2);
  add('_'.repeat(95), { size: 8 });
  drop(6);
  add(german ? 'Gesamtsumme' : 'Order Total', { bold: true, x: 330, y: at() });
  add(`${german ? 'EUR' : 'GBP'} ${money(total)}`, { bold: true, x: 420, y: at() });
  drop(24);

  // Rows that are deliberately NOT line items — the prompt has to exclude them.
  add(german ? 'Verpackung und Fracht werden gesondert berechnet.' : 'Carriage and handling charged separately at cost.', { size: 8 });
  add(german ? 'Kontakt: einkauf@mock-industries.example' : 'Contact: purchasing@northwind-trading.example', { size: 8 });

  return { rows, lines };
}

/** US industrial distributor: month-name dates, FOB terms, freight note to exclude. */
function buildApex(): { rows: Row[]; lines: Line[] } {
  const { rows, add, drop, at } = makeSheet();
  const lines = pickLines([0, 1, 3, 4], [2500, 5000, 12, 8]);
  const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  add('APEX FASTENER SUPPLY INC.', { size: 16, bold: true });
  add('4180 Commerce Drive, Dayton, OH 45402, USA');
  add('Fed Tax ID 31-1745598  ·  www.apexfastener.example');
  drop(14);

  add('PURCHASE ORDER', { size: 14, bold: true });
  drop(6);

  add('P.O. Number: APX-118276', { bold: true });
  add('P.O. Date: Sep 18, 2026');
  add('Ship By: Oct 05, 2026');
  add('Vendor Account: C-3305');
  add('Currency: USD');
  add('Terms: Net 30');
  add('FOB: Origin - Freight Collect');
  drop(8);

  add('Ship To:', { bold: true });
  add('Apex Fastener Supply, Receiving Dock 2 (ATTN: J. Alvarez), 4180 Commerce Drive, Dayton, OH 45402');
  add('Bill To:', { bold: true });
  add('Apex Fastener Supply - Accounts Payable, P.O. Box 9917, Dayton, OH 45401');
  drop(10);

  const cols = [50, 80, 145, 330, 385, 420, 485];
  ['ITEM', 'PART NO', 'DESCRIPTION', 'QTY', 'UM', 'UNIT COST', 'EXT COST'].forEach((h, i) =>
    add(h, { bold: true, x: cols[i], y: at(), size: 8 }),
  );
  drop(4);
  add('_'.repeat(95), { size: 8 });
  drop(4);

  let total = 0;
  for (const line of lines) {
    const amount = line.qty * line.price;
    total += amount;
    const cells = [String(line.pos), line.code, line.description, String(line.qty), line.uom, money(line.price), money(amount)];
    cells.forEach((c, i) => add(c, { x: cols[i], y: at() }));
    drop(14);
  }

  drop(2);
  add('_'.repeat(95), { size: 8 });
  drop(6);
  add('ORDER TOTAL', { bold: true, x: 330, y: at() });
  add(`USD ${money(total)}`, { bold: true, x: 420, y: at() });
  drop(24);

  add('FREIGHT: Prepay & add. Do not backorder without confirmation.', { size: 8 });
  add('Confirm receipt within 24 hours. Buyer: buyer@apexfastener.example', { size: 8 });

  return { rows, lines };
}

/** Indian manufacturer: GSTIN, HSN column (a tax code, NOT a material number), lakh grouping. */
function buildShakti(): { rows: Row[]; lines: Line[] } {
  const { rows, add, drop, at } = makeSheet();
  const lines = pickLines([0, 1, 2, 3, 4], [10000, 20000, 40, 25, 12], 90);
  const money = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const HSN = ['73181500', '73182200', '40093200', '27101980', '84814000'];

  add('Shakti Engineering Works Pvt. Ltd.', { size: 16, bold: true });
  add('Plot 47, MIDC Bhosari, Pune 411026, Maharashtra, India');
  add('GSTIN: 27AABCS1429B1ZL  ·  CIN: U29253PN1998PTC012345');
  drop(14);

  add('PURCHASE ORDER', { size: 14, bold: true });
  drop(6);

  add('PO No: SEW/2026-27/0912', { bold: true });
  add('PO Date: 18-09-2026');
  add('Delivery Date: 10-10-2026');
  add('Party Code: C-5521');
  add('Currency: INR');
  add('Payment: 45 days from date of invoice');
  add('Incoterms: EXW Pune');
  drop(8);

  add('Deliver To (Kind Attn: Stores Dept.):', { bold: true });
  add('Shakti Engineering Works, Gate 2 Stores, Plot 47, MIDC Bhosari, Pune 411026');
  add('Bill To:', { bold: true });
  add('Shakti Engineering Works Pvt. Ltd., Plot 47, MIDC Bhosari, Pune 411026 (GSTIN 27AABCS1429B1ZL)');
  drop(10);

  const cols = [50, 72, 130, 185, 345, 393, 425, 490];
  ['Sr', 'Mat. Code', 'HSN', 'Description', 'Qty', 'UOM', 'Rate', 'Amount'].forEach((h, i) =>
    add(h, { bold: true, x: cols[i], y: at(), size: 8 }),
  );
  drop(4);
  add('_'.repeat(95), { size: 8 });
  drop(4);

  let total = 0;
  lines.forEach((line, idx) => {
    const amount = line.qty * line.price;
    total += amount;
    const cells = [String(line.pos), line.code, HSN[idx]!, line.description, String(line.qty), line.uom, money(line.price), money(amount)];
    cells.forEach((c, i) => add(c, { x: cols[i], y: at(), size: 8 }));
    drop(14);
  });

  drop(2);
  add('_'.repeat(95), { size: 8 });
  drop(6);
  add('Basic Total', { bold: true, x: 345, y: at() });
  add(`INR ${money(total)}`, { bold: true, x: 425, y: at() });
  drop(18);

  // Not line items, and GST is deliberately NOT part of the PO total.
  add('GST @ 18% extra as applicable at the time of supply.', { size: 8 });
  add('Test certificates (EN 10204 3.1) required with each consignment.', { size: 8 });
  add('Contact: purchase@shaktiengg.example  ·  Tel +91 20 5550 1284', { size: 8 });

  return { rows, lines };
}

/** Swedish lab supplier: ISO dates, spaced thousands with comma decimals, bilingual title. */
function buildNordica(): { rows: Row[]; lines: Line[] } {
  const { rows, add, drop, at } = makeSheet();
  const lines = pickLines([2, 3, 4], [8, 15, 4], 11);
  const money = (n: number) => n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

  add('Nordica Lab Supplies AB', { size: 16, bold: true });
  add('Instrumentvägen 12, 421 32 Göteborg, Sverige');
  add('Org.nr 556677-8899  ·  VAT SE556677889901');
  drop(14);

  add('INKÖPSORDER / PURCHASE ORDER', { size: 14, bold: true });
  drop(6);

  add('Ordernr: NLS-30442', { bold: true });
  add('Orderdatum: 2026-09-18');
  add('Önskad leverans: 2026-10-01');
  add('Kundnr: C-9083');
  add('Valuta: SEK');
  add('Betalningsvillkor: 30 dagar netto');
  add('Leveransvillkor: DDP Göteborg');
  drop(8);

  add('Leveransadress:', { bold: true });
  add('Nordica Lab Supplies, Godsmottagning, Instrumentvägen 12, 421 32 Göteborg');
  add('Fakturaadress:', { bold: true });
  add('Nordica Lab Supplies AB, FE 5580, 838 77 Frösön');
  drop(10);

  const cols = [50, 85, 150, 340, 390, 425, 490];
  ['Rad', 'Artikel', 'Beskrivning', 'Antal', 'Enh', 'À-pris', 'Summa'].forEach((h, i) =>
    add(h, { bold: true, x: cols[i], y: at(), size: 8 }),
  );
  drop(4);
  add('_'.repeat(95), { size: 8 });
  drop(4);

  let total = 0;
  for (const line of lines) {
    const amount = line.qty * line.price;
    total += amount;
    const cells = [String(line.pos), line.code, line.description, String(line.qty), line.uom, money(line.price), money(amount)];
    cells.forEach((c, i) => add(c, { x: cols[i], y: at() }));
    drop(14);
  }

  drop(2);
  add('_'.repeat(95), { size: 8 });
  drop(6);
  add('Ordersumma', { bold: true, x: 340, y: at() });
  add(`SEK ${money(total)}`, { bold: true, x: 425, y: at() });
  drop(24);

  add('Frakt debiteras separat. Ange ordernr på följesedel och faktura.', { size: 8 });
  add('Kontakt: inkop@nordicalab.example', { size: 8 });

  return { rows, lines };
}

/**
 * Multi-column layout: ORDER / DELIVER TO / INVOICE TO sit side by side, so the
 * page's natural text order jumps between unrelated facts — a layout naive
 * line-by-line readers get badly wrong.
 */
function buildColumns(): { rows: Row[]; lines: Line[] } {
  const { rows, add, drop, at } = makeSheet();
  const lines = pickLines([0, 2, 3, 4], [4000, 20, 30, 10], 1.5);
  const money = (n: number) => n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  add('MERIDIAN FOOD DISTRIBUTORS PTY LTD', { size: 15, bold: true });
  add('18 Cold Store Road, Laverton North VIC 3026, Australia  ·  ABN 53 004 085 616');
  drop(12);
  add('PURCHASE ORDER', { size: 13, bold: true });
  drop(10);

  // Three blocks across the page, each with its own little y-cursor.
  const top = at();
  const block = (x: number, title: string, body: string[]) => {
    let by = top;
    rows.push({ text: title, size: 8, bold: true, x, y: by });
    by -= 13;
    for (const line of body) {
      rows.push({ text: line, size: 8, bold: false, x, y: by });
      by -= 12;
    }
    return by;
  };

  const b1 = block(50, 'ORDER', [
    'PO No: MFD-72091',
    'Date: 19/09/2026',
    'Deliver by: 03/10/2026',
    'Account: C-6620',
    'Currency: AUD',
  ]);
  const b2 = block(230, 'DELIVER TO', [
    'Meridian DC 4, Goods In',
    '18 Cold Store Road',
    'Laverton North VIC 3026',
    'Attn: Receiving Supervisor',
    'Dock hours 05:00-13:00',
  ]);
  const b3 = block(410, 'INVOICE TO', [
    'Meridian Food Distributors',
    'PO Box 812',
    'Melbourne VIC 3001',
    'Terms: 21 days EOM',
    'Incoterms: DDP Laverton',
  ]);
  drop(top - Math.min(b1, b2, b3) + 14);

  const cols = [50, 85, 150, 340, 390, 425, 490];
  ['Line', 'Product', 'Description', 'Qty', 'Unit', 'Price', 'Value'].forEach((h, i) =>
    add(h, { bold: true, x: cols[i], y: at(), size: 8 }),
  );
  drop(4);
  add('_'.repeat(95), { size: 8 });
  drop(4);

  let total = 0;
  for (const line of lines) {
    const amount = line.qty * line.price;
    total += amount;
    const cells = [String(line.pos), line.code, line.description, String(line.qty), line.uom, money(line.price), money(amount)];
    cells.forEach((c, i) => add(c, { x: cols[i], y: at() }));
    drop(14);
  }

  drop(2);
  add('_'.repeat(95), { size: 8 });
  drop(6);
  add('Order total (GST incl.)', { bold: true, x: 340, y: at() });
  add(`AUD ${money(total)}`, { bold: true, x: 425, y: at() });
  drop(24);

  add('Prices include GST at 10%. Pallet deposit AUD 45.00 is refundable and not an order line.', { size: 8 });
  add('Contact: buying@meridianfoods.example', { size: 8 });

  return { rows, lines };
}

/**
 * Letter format: the entire order is prose. Nothing is labelled, dates are written
 * long-hand, and the line items live inside sentences — the hardest text layout a
 * real inbox produces.
 */
function buildLetter(): { rows: Row[]; lines: Line[] } {
  const { rows, add, drop } = makeSheet();
  const lines: Line[] = [
    { pos: 1, code: 'MAT-5567', customerCode: '', description: 'Hydraulic hose assembly 1/2" 2m', qty: 60, uom: 'EA', price: 92.95 },
    { pos: 2, code: 'MAT-9021', customerCode: '', description: 'Industrial lubricant, 20L drum', qty: 14, uom: 'BOX', price: 145.2 },
    { pos: 3, code: 'MAT-3390', customerCode: '', description: 'Safety valve, 16 bar, DN25', qty: 6, uom: 'EA', price: 241.73 },
  ];

  add('Cascade Timber & Joinery Ltd', { size: 15, bold: true });
  add('Unit 9, Riverside Business Park, Cork T12 XW70, Ireland');
  add('VAT IE6388047V  ·  Tel +353 21 555 0164');
  drop(18);

  add('24 September 2026');
  drop(10);
  add('To: Sales Order Desk');
  drop(14);

  add('PURCHASE ORDER CTJ-2026-118', { size: 12, bold: true });
  drop(10);

  add('Dear Sir or Madam,');
  drop(6);
  add('Please accept this letter as our official purchase order CTJ-2026-118, raised on');
  add('24 September 2026 against our account number C-8845. We would be grateful for');
  add('delivery no later than 15 October 2026 to our workshop at Unit 9, Riverside');
  add('Business Park, Cork, marked for the attention of the joinery foreman.');
  drop(8);
  add('As per your quotation Q-4471, we wish to order the following, all prices in');
  add('euro and excluding VAT:');
  drop(8);
  add('  -  60 of hydraulic hose assembly 1/2" 2m (your ref MAT-5567) at EUR 92.95 each;');
  add('  -  14 of industrial lubricant, 20L drum (your ref MAT-9021), supplied boxed,');
  add('     at EUR 145.20 per box;');
  add('  -  6 of safety valve, 16 bar, DN25 (your ref MAT-3390) at EUR 241.73 each.');
  drop(8);
  add('The goods total EUR 9,060.18. Invoices fall due 30 days from the invoice date.');
  add('Delivery is DAP Cork. Please send the invoice to our accounts office at the');
  add('address above, quoting the order number.');
  drop(14);
  add('Yours faithfully,');
  drop(16);
  add('Aoife Brennan', { bold: true });
  add('Purchasing, Cascade Timber & Joinery Ltd');
  add('purchasing@cascadetimber.example');

  return { rows, lines };
}

// -------------------------------------------------------------- text-layer PDF

function assemblePdf(objects: (string | Buffer)[]): Buffer {
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

function buildTextPdf(rows: Row[]): Buffer {
  const content = rows
    .map((r) => `BT /${r.bold ? 'F2' : 'F1'} ${r.size} Tf 1 0 0 1 ${r.x} ${r.y} Tm (${escapePdf(r.text)}) Tj ET`)
    .join('\n');

  return assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ]);
}

// ------------------------------------------------------------------ fax scan
//
// A page rendered entirely as a grayscale image: a 5x7 bitmap font stamped into a
// pixel buffer, deflated, and embedded as an Image XObject. There is no text layer,
// so extracting this document requires actually *reading the pixels* — it exists to
// prove the vision path works on scans and faxes, not just born-digital PDFs.

const GLYPHS: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '/': ['00001', '00010', '00100', '00100', '00100', '01000', '10000'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  '&': ['01100', '10010', '10100', '01000', '10101', '10010', '01101'],
  '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'],
  '@': ['01110', '10001', '10111', '10101', '10110', '10000', '01110'],
  '%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '"': ['01010', '01010', '00000', '00000', '00000', '00000', '00000'],
  "'": ['00100', '00100', '01000', '00000', '00000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

class FaxPage {
  readonly w = 1240;
  readonly h = 1754;
  readonly px: Uint8Array;

  constructor() {
    this.px = new Uint8Array(this.w * this.h).fill(255);
  }

  private dot(x: number, y: number, v: number) {
    if (x >= 0 && x < this.w && y >= 0 && y < this.h) this.px[y * this.w + x] = v;
  }

  text(x: number, y: number, s: string, scale = 2, bold = false) {
    let cx = x;
    for (const raw of s.toUpperCase()) {
      const glyph = GLYPHS[raw] ?? GLYPHS[' ']!;
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 5; c++) {
          if (glyph[r]![c] !== '1') continue;
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              this.dot(cx + c * scale + dx, y + r * scale + dy, 20);
              if (bold) this.dot(cx + c * scale + dx + 1, y + r * scale + dy, 20);
            }
          }
        }
      }
      cx += 6 * scale;
    }
  }

  rule(x1: number, x2: number, y: number, thickness = 2) {
    for (let x = x1; x <= x2; x++) for (let t = 0; t < thickness; t++) this.dot(x, y + t, 20);
  }

  /** Toner specks and one faint streak — enough to read as a fax, not enough to obscure. */
  grunge() {
    for (let i = 0; i < 1400; i++) {
      this.dot(Math.floor(Math.random() * this.w), Math.floor(Math.random() * this.h), 120 + Math.floor(Math.random() * 100));
    }
    const streakY = 640;
    for (let x = 0; x < this.w; x++) if (Math.random() < 0.35) this.dot(x, streakY, 190);
  }
}

function buildScanPdf(): { pdf: Buffer; lines: Line[] } {
  const lines = pickLines([0, 2, 4], [750, 10, 2]);
  const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const page = new FaxPage();
  const L = 90;
  let y = 46;

  page.text(L, y, 'FROM: ORION METALS 713 555 0107      09/17/2026 14:32      PG 1/1', 2);
  y += 40;
  page.rule(L, page.w - L, y, 2);
  y += 36;

  page.text(L, y, 'ORION METALS & ALLOYS LLC', 4, true);
  y += 42;
  page.text(L, y, '8100 WALLISVILLE RD, HOUSTON TX 77029', 2);
  y += 24;
  page.text(L, y, 'TEL (713) 555-0182   FAX (713) 555-0107', 2);
  y += 40;

  page.text(L, y, 'PURCHASE ORDER', 3, true);
  y += 44;

  const kv: [string, string][] = [
    ['PO NUMBER', 'OM-77-3319'],
    ['PO DATE', 'SEP 17, 2026'],
    ['SHIP BY', 'OCT 08, 2026'],
    ['ACCOUNT NO', 'C-4410'],
    ['CURRENCY', 'USD'],
    ['TERMS', 'NET 30'],
    ['FOB', 'HOUSTON TX'],
  ];
  for (const [k, v] of kv) {
    page.text(L, y, `${k}:`, 2, true);
    page.text(L + 170, y, v, 2);
    y += 26;
  }
  y += 12;

  page.text(L, y, 'SHIP TO:', 2, true);
  y += 24;
  page.text(L, y, 'ORION METALS RECEIVING, GATE 4, 8100 WALLISVILLE RD, HOUSTON TX 77029', 2);
  y += 30;
  page.text(L, y, 'BILL TO:', 2, true);
  y += 24;
  page.text(L, y, 'ORION METALS A/P, PO BOX 2210, HOUSTON TX 77252', 2);
  y += 40;

  // Monospace grid: fixed-width strings keep the columns aligned.
  const rowText = (c: string[]) =>
    c[0]!.padEnd(4) + c[1]!.padEnd(11) + c[2]!.padEnd(34) + c[3]!.padStart(6) + '  ' + c[4]!.padEnd(5) + c[5]!.padStart(9) + c[6]!.padStart(12);
  page.text(L, y, rowText(['LN', 'PART NO', 'DESCRIPTION', 'QTY', 'UM', 'PRICE', 'AMOUNT']), 2, true);
  y += 24;
  page.rule(L, page.w - L, y, 2);
  y += 16;

  let total = 0;
  for (const line of lines) {
    const amount = line.qty * line.price;
    total += amount;
    page.text(L, y, rowText([String(line.pos), line.code, line.description.toUpperCase(), String(line.qty), line.uom, money(line.price), money(amount)]), 2);
    y += 28;
  }
  y += 4;
  page.rule(L, page.w - L, y, 2);
  y += 20;
  page.text(L + 640, y, `TOTAL USD ${money(total)}`, 2, true);
  y += 44;

  page.text(L, y, 'MATERIAL CERTS REQUIRED. NO PARTIAL SHIPMENTS.', 2);
  y += 26;
  page.text(L, y, 'CONTACT: PURCHASING@ORIONMETALS.EXAMPLE', 2);

  page.grunge();

  const image = zlib.deflateSync(Buffer.from(page.px));
  const content = Buffer.from('q 595 0 0 842 0 0 cm /Im1 Do Q', 'latin1');

  const pdf = assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 5 0 R >> /ProcSet [/PDF /ImageB] >> /Contents 4 0 R >>',
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream', 'latin1')]),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${page.w} /Height ${page.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`,
        'latin1',
      ),
      image,
      Buffer.from('\nendstream', 'latin1'),
    ]),
  ]);

  return { pdf, lines };
}

// --------------------------------------------------------------------- main

const args = process.argv.slice(2);
const vendorArg = args.find((a) => a.startsWith('--vendor='))?.split('=')[1] ?? 'mock';
if (!(VENDOR_KEYS as readonly string[]).includes(vendorArg)) {
  console.error(`Unknown vendor "${vendorArg}". Pick one of: ${VENDOR_KEYS.join(', ')}`);
  process.exit(1);
}
const vendor = vendorArg as VendorKey;
const outPath = args.find((a) => !a.startsWith('--')) ?? `sample-po-${vendor}.pdf`;

let pdf: Buffer;
let lines: Line[];
if (vendor === 'scan') {
  ({ pdf, lines } = buildScanPdf());
} else {
  const built =
    vendor === 'apex' ? buildApex()
    : vendor === 'shakti' ? buildShakti()
    : vendor === 'nordica' ? buildNordica()
    : vendor === 'columns' ? buildColumns()
    : vendor === 'letter' ? buildLetter()
    : buildClassic(vendor);
  pdf = buildTextPdf(built.rows);
  lines = built.lines;
}

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, pdf);
console.log(`Wrote ${outPath} (${pdf.length} bytes, ${lines.length} line items, vendor: ${vendor})`);
