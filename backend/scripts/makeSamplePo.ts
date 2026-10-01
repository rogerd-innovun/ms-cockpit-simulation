/**
 * Generates realistic PO PDFs with no PDF dependency, so the lifecycle can be exercised
 * without hunting for real customer documents. Most layouts are genuine text-bearing PDFs
 * (Gemini reads the text; `multipage` runs to two pages); `scan` and `skewscan` are
 * rasterised pages with NO text layer at all, which proves the extractor reads pure
 * images too.
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
 *   multipage      UK marine supplier     GBP  DD/MM/YYYY   two pages, repeated header, carried-forward rows
 *   bondecommande  French engineering     EUR  DD/MM/YYYY   "1 234,56", accents, Total HT / TVA / Total TTC
 *   ordine         Italian plant builder  EUR  DD/MM/YYYY   item nos 10-50, per-line dates and plants, Ns./Vs. codice
 *   discounts      Canadian supply house  CAD  DD-MON-YYYY  list / disc % / net price, a free line, freight and HST
 *   skewscan       Dutch machine builder  EUR  DD-MM-YYYY   image only, rotated, faint, scanner shadow and a stamp
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { assemblePdf, buildMultiPagePdf, buildTextPdf, makeSheet, type Row } from './lib/pdfSheet.js';

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

/** More of the same catalogue, for the long PO that needs sixteen distinct lines. */
const EXTRA_MATERIALS: Omit<Line, 'pos' | 'qty'>[] = [
  { code: 'MAT-1043', customerCode: 'CM-8806', description: 'Hex bolt M12x50 zinc plated', uom: 'EA', price: 0.68 },
  { code: 'MAT-1044', customerCode: 'CM-8807', description: 'Hex nut M10 zinc plated', uom: 'EA', price: 0.09 },
  { code: 'MAT-1051', customerCode: 'CM-8808', description: 'Spring washer M10 A2', uom: 'EA', price: 0.06 },
  { code: 'MAT-2420', customerCode: 'CM-8809', description: 'Cable tie 200mm black, pack of 100', uom: 'PK', price: 14.8 },
  { code: 'MAT-2701', customerCode: 'CM-8810', description: 'Rubber O-ring 40x3 NBR', uom: 'EA', price: 0.95 },
  { code: 'MAT-4105', customerCode: 'CM-8811', description: 'Ball valve 1/2" brass', uom: 'EA', price: 12.4 },
  { code: 'MAT-4106', customerCode: 'CM-8812', description: 'Ball valve 1" brass', uom: 'EA', price: 21.9 },
  { code: 'MAT-5570', customerCode: 'CM-8813', description: 'Hydraulic hose assembly 3/4" 3m', uom: 'EA', price: 118.6 },
  { code: 'MAT-6120', customerCode: 'CM-8814', description: 'Pipe clamp 32mm galvanised', uom: 'EA', price: 1.85 },
  { code: 'MAT-7340', customerCode: 'CM-8815', description: 'Grease cartridge 400g', uom: 'EA', price: 4.35 },
  { code: 'MAT-8812', customerCode: 'CM-8816', description: 'Nitrile gloves size L, box of 100', uom: 'BOX', price: 9.2 },
];

const VENDOR_KEYS = [
  'mock', 'northwind', 'apex', 'shakti', 'nordica', 'scan', 'columns', 'letter',
  'multipage', 'bondecommande', 'ordine', 'discounts', 'skewscan',
] as const;
type VendorKey = (typeof VENDOR_KEYS)[number];

const round2 = (n: number) => Math.round(n * 100) / 100;
/** 1 234,56 — ASCII space, because the usual narrow no-break space is not in WinAnsi. */
const spaced = (n: number) => n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
/** 1.234,56 */
const dotted = (n: number) => n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');

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

/**
 * Two pages. The column header repeats on page 2, page 1 ends with a "carried forward"
 * subtotal and page 2 opens with the matching "brought forward" row — neither is a line
 * item — and the order total appears once, at the very end. A reader that treats each
 * page on its own duplicates or drops lines at the break, or reads a subtotal as a line.
 */
function buildMultiPage(): { pdf: Buffer; lines: Line[] } {
  const catalogue = [...MATERIALS, ...EXTRA_MATERIALS];
  const qtys = [400, 800, 6, 2, 3, 250, 500, 40, 12, 6, 20, 8, 150, 60, 30, 10];
  const lines: Line[] = catalogue.map((m, i) => ({ ...m, pos: i + 1, qty: qtys[i]! }));
  const money = (n: number) => n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const amountOf = (l: Line) => round2(l.qty * l.price);
  const onFirstPage = lines.slice(0, 10);
  const onSecondPage = lines.slice(10);
  const carried = round2(onFirstPage.reduce((s, l) => s + amountOf(l), 0));
  const total = round2(lines.reduce((s, l) => s + amountOf(l), 0));

  const cols = [50, 82, 150, 345, 385, 420, 482];
  type Sheet = ReturnType<typeof makeSheet>;
  const tableHead = (s: Sheet) => {
    ['Line', 'Code', 'Description', 'Qty', 'UOM', 'Price', 'Amount'].forEach((h, i) =>
      s.add(h, { bold: true, x: cols[i], y: s.at() }),
    );
    s.drop(4);
    s.add('_'.repeat(95), { size: 8 });
    s.drop(4);
  };
  const lineRow = (s: Sheet, l: Line) => {
    [String(l.pos), l.code, l.description, String(l.qty), l.uom, money(l.price), money(amountOf(l))].forEach((c, i) =>
      s.add(c, { x: cols[i], y: s.at() }),
    );
    s.drop(14);
  };
  const footer = (s: Sheet, n: number) => s.rows.push({ text: `Page ${n} of 2`, size: 8, bold: false, x: 270, y: 40 });

  const p1 = makeSheet();
  p1.add('Harbourside Marine Supplies Ltd', { size: 16, bold: true });
  p1.add('Unit 3, Berth 207 Business Quay, Southampton SO14 3QX, United Kingdom');
  p1.add('VAT Reg. GB402118563');
  p1.drop(14);
  p1.add('PURCHASE ORDER', { size: 14, bold: true });
  p1.drop(6);
  p1.add('Order Ref: HMS-55102', { bold: true });
  p1.add('Order Date: 18/09/2026');
  p1.add('Required By: 09/10/2026');
  p1.add('Account No: C-1187');
  p1.add('Currency: GBP');
  p1.add('Payment Terms: Net 30');
  p1.add('Incoterms: CIP Southampton');
  p1.drop(8);
  p1.add('Deliver To:', { bold: true });
  p1.add('Goods Inwards, Berth 207 Business Quay, Southampton SO14 3QX');
  p1.add('Invoice To:', { bold: true });
  p1.add('Accounts Payable, PO Box 1190, Southampton SO15 0BR');
  p1.drop(10);
  tableHead(p1);
  onFirstPage.forEach((l) => lineRow(p1, l));
  p1.drop(2);
  p1.add('_'.repeat(95), { size: 8 });
  p1.drop(6);
  p1.add('Continued overleaf - subtotal carried forward', { x: 200, y: p1.at() });
  p1.add(`GBP ${money(carried)}`, { bold: true, x: 440, y: p1.at() });
  footer(p1, 1);

  const p2 = makeSheet();
  p2.add('Harbourside Marine Supplies Ltd - Order Ref HMS-55102 (continued)', { size: 11, bold: true });
  p2.drop(10);
  tableHead(p2);
  p2.add('Brought forward', { x: 150, y: p2.at() });
  p2.add(money(carried), { x: 482, y: p2.at() });
  p2.drop(14);
  onSecondPage.forEach((l) => lineRow(p2, l));
  p2.drop(2);
  p2.add('_'.repeat(95), { size: 8 });
  p2.drop(6);
  p2.add('Order Total', { bold: true, x: 345, y: p2.at() });
  p2.add(`GBP ${money(total)}`, { bold: true, x: 420, y: p2.at() });
  p2.drop(24);
  p2.add('Carriage and handling charged separately at cost.', { size: 8 });
  p2.add('Contact: purchasing@harbourside-marine.example', { size: 8 });
  footer(p2, 2);

  return { pdf: buildMultiPagePdf([p1.rows, p2.rows]), lines };
}

/**
 * French engineering firm. Money is "1 234,56", the page carries accents, and the foot of
 * the order is Total HT / TVA / Total TTC: three totals, of which only the first (the goods,
 * before VAT) is the PO total — the one that equals the sum of the lines.
 */
function buildFrench(): { rows: Row[]; lines: Line[] } {
  const { rows, add, drop, at } = makeSheet();
  const spec = [
    { mi: 0, d: 'Boulon hexagonal M10x40 zingué', u: 'U', qty: 3000 },
    { mi: 2, d: 'Flexible hydraulique 1/2 pouce, 2 m', u: 'U', qty: 14 },
    { mi: 3, d: 'Lubrifiant industriel, fût 20 L', u: 'CRT', qty: 8 },
    { mi: 4, d: 'Soupape de sécurité 16 bar, DN25', u: 'U', qty: 5 },
  ];
  const lines: Line[] = spec.map((s, i) => ({ ...MATERIALS[s.mi]!, description: s.d, uom: s.u, qty: s.qty, pos: i + 1 }));
  const amountOf = (l: Line) => round2(l.qty * l.price);
  const ht = round2(lines.reduce((s, l) => s + amountOf(l), 0));
  const tva = round2(ht * 0.2);

  add('Établissements Lemaire SA', { size: 16, bold: true });
  add('27 rue de la République, 69002 Lyon, France');
  add('SIRET 552 081 317 00019  ·  TVA FR40552081317');
  drop(14);

  add('BON DE COMMANDE', { size: 14, bold: true });
  drop(6);

  add('N° de commande : LEM-26-04417', { bold: true });
  add('Date de commande : 18/09/2026');
  add('Livraison souhaitée : 09/10/2026');
  add('N° client : C-3912');
  add('Devise : EUR');
  add('Conditions de paiement : 45 jours fin de mois');
  add('Incoterm : DAP Lyon');
  drop(8);

  add('Adresse de livraison :', { bold: true });
  add('Entrepôt central, Quai 6, 114 avenue Jean Jaurès, 69007 Lyon');
  add('Adresse de facturation :', { bold: true });
  add('Service comptabilité fournisseurs, BP 3320, 69214 Lyon Cedex 02');
  drop(10);

  const cols = [50, 82, 135, 340, 380, 420, 485];
  ['Pos', 'Réf.', 'Désignation', 'Qté', 'U', 'PU HT', 'Montant HT'].forEach((h, i) =>
    add(h, { bold: true, x: cols[i], y: at() }),
  );
  drop(4);
  add('_'.repeat(95), { size: 8 });
  drop(4);

  for (const line of lines) {
    [String(line.pos), line.code, line.description, String(line.qty), line.uom, spaced(line.price), spaced(amountOf(line))].forEach(
      (c, i) => add(c, { x: cols[i], y: at() }),
    );
    drop(14);
  }

  drop(2);
  add('_'.repeat(95), { size: 8 });
  drop(6);
  add('Total HT', { bold: true, x: 340, y: at() });
  add(`EUR ${spaced(ht)}`, { bold: true, x: 420, y: at() });
  drop(14);
  add('TVA 20 %', { x: 340, y: at() });
  add(`EUR ${spaced(tva)}`, { x: 420, y: at() });
  drop(14);
  add('Total TTC', { bold: true, x: 340, y: at() });
  add(`EUR ${spaced(round2(ht + tva))}`, { bold: true, x: 420, y: at() });
  drop(24);

  add('Emballages consignés non facturés. Rappeler le N° de commande sur le bon de livraison et la facture.', { size: 8 });
  add('Contact : achats@lemaire-sa.example', { size: 8 });

  return { rows, lines };
}

/**
 * Italian plant builder, written the way SAP-fed buyers write them: item numbers 10-50,
 * a delivery date and a plant on every line, and two code columns whose names depend on
 * whose side you stand on — "Vs. cod." is YOUR (the supplier's) code, which is our material
 * number; "Ns. cod." is THEIRS. The "Fornitore n." in the header is the buyer's number for
 * us, not our code for them, and the page carries no customer code at all.
 */
function buildItalian(): { rows: Row[]; lines: Line[] } {
  const { rows, add, drop, at } = makeSheet();
  const spec = [
    { mi: 0, ns: 'BI-20110', d: 'Bullone esagonale M10x40 zincato', qty: 2400, um: 'PZ', due: '05/10/2026', plant: 'BS01' },
    { mi: 1, ns: 'BI-20118', d: 'Rondella inox DIN125 10 mm', qty: 5000, um: 'PZ', due: '05/10/2026', plant: 'BS01' },
    { mi: 2, ns: 'BI-31405', d: 'Tubo idraulico 1/2" 2 m', qty: 24, um: 'PZ', due: '12/10/2026', plant: 'BS02' },
    { mi: 3, ns: 'BI-47720', d: 'Lubrificante industriale, fusto 20 L', qty: 10, um: 'FST', due: '12/10/2026', plant: 'BS02' },
    { mi: 4, ns: 'BI-52086', d: 'Valvola di sicurezza 16 bar DN25', qty: 6, um: 'PZ', due: '26/10/2026', plant: 'BS01' },
  ];
  const lines: Line[] = spec.map((s, i) => ({
    ...MATERIALS[s.mi]!, customerCode: s.ns, description: s.d, uom: s.um, qty: s.qty, pos: (i + 1) * 10,
  }));
  const amountOf = (l: Line) => round2(l.qty * l.price);
  const total = round2(lines.reduce((s, l) => s + amountOf(l), 0));

  add('Bertolini Impianti S.p.A.', { size: 16, bold: true });
  add("Via dell'Industria 21, 25126 Brescia BS, Italia");
  add('P.IVA IT01234560988  ·  C.F. 01234560988');
  drop(14);

  add("ORDINE D'ACQUISTO", { size: 14, bold: true });
  drop(6);

  add('N. ordine: OA/2026/003318', { bold: true });
  add('Data ordine: 18/09/2026');
  add('Fornitore n.: 40871');
  add('Valuta: EUR');
  add('Pagamento: Bonifico 60 gg data fattura');
  add('Resa: FCA Brescia');
  add('Consegna: come indicato per ogni riga');
  drop(8);

  add('Destinazione merce:', { bold: true });
  add("Stabilimento BS01 / BS02, Via dell'Industria 21, 25126 Brescia");
  add('Fatturare a:', { bold: true });
  add('Bertolini Impianti S.p.A. - Ufficio contabilita, Casella postale 118, 25100 Brescia');
  drop(10);

  const cols = [40, 64, 118, 176, 330, 360, 392, 440, 488, 548];
  ['Pos', 'Vs. cod.', 'Ns. cod.', 'Descrizione', "Q.ta'", 'UM', 'Prezzo', 'Importo', 'Consegna', 'Stab.'].forEach((h, i) =>
    add(h, { bold: true, x: cols[i], y: at(), size: 7 }),
  );
  drop(4);
  add('_'.repeat(110), { size: 7 });
  drop(4);

  lines.forEach((line, i) => {
    const s = spec[i]!;
    [String(line.pos), line.code, line.customerCode, line.description, String(line.qty), line.uom, dotted(line.price), dotted(amountOf(line)), s.due, s.plant].forEach(
      (c, j) => add(c, { x: cols[j], y: at(), size: 7 }),
    );
    drop(13);
  });

  drop(2);
  add('_'.repeat(110), { size: 7 });
  drop(6);
  add('Totale ordine (IVA esclusa)', { bold: true, x: 300, y: at() });
  add(`EUR ${dotted(total)}`, { bold: true, x: 440, y: at() });
  drop(24);

  add("Si prega di confermare l'ordine entro 3 giorni lavorativi. IVA al 22% a nostro carico.", { size: 8 });
  add('Contatto: acquisti@bertolini-impianti.example', { size: 8 });

  return { rows, lines };
}

/**
 * Canadian supply house. The price columns run List / Disc % / Net / Extended, and the
 * unit price the order is placed at is the NET one (quantity x net = extended). One line is
 * a free sample at a price of zero — still an ordered line. Under the lines sit a goods
 * subtotal, freight, a fuel surcharge, HST and a grand total; the PO total is the subtotal.
 */
function buildDiscounts(): { rows: Row[]; lines: Line[] } {
  const { rows, add, drop, at } = makeSheet();
  const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const spec = [
    { mi: 0, d: 'Hex bolt M10x40 zinc (pack of 100)', qty: 40, um: 'PK', list: 46.2, disc: 10 },
    { mi: 2, d: 'Hydraulic hose assembly 1/2" 2m', qty: 12, um: 'EA', list: 99.4, disc: 15 },
    { mi: 3, d: 'Industrial lubricant, 20L drum', qty: 6, um: 'DR', list: 145.2, disc: 0 },
    { mi: 4, d: 'Safety valve, 16 bar, DN25', qty: 4, um: 'EA', list: 241.73, disc: 12 },
    { mi: 1, d: 'Washer DIN125 10mm - FREE SAMPLE', qty: 500, um: 'EA', list: 0.12, disc: 100 },
  ];
  const lines: Line[] = spec.map((s, i) => ({
    ...MATERIALS[s.mi]!, description: s.d, uom: s.um, qty: s.qty, pos: i + 1, price: round2(s.list * (1 - s.disc / 100)),
  }));
  const amountOf = (l: Line) => round2(l.qty * l.price);
  const subtotal = round2(lines.reduce((s, l) => s + amountOf(l), 0));
  const freight = 85;
  const fuel = 12.5;
  const hst = round2((subtotal + freight + fuel) * 0.13);
  const due = round2(subtotal + freight + fuel + hst);

  add('MAPLE RIDGE INDUSTRIAL SUPPLY INC.', { size: 16, bold: true });
  add('1450 Fraser Way, Burlington, ON L7L 4X3, Canada');
  add('GST/HST Reg. 884422119 RT0001  ·  www.mapleridge-supply.example');
  drop(14);

  add('PURCHASE ORDER', { size: 14, bold: true });
  drop(6);

  add('PO #: MR-0066218', { bold: true });
  add('Order Date: 18-SEP-2026');
  add("Req'd By: 09-OCT-2026");
  add('Cust #: C-6104');
  add('Currency: CAD');
  add('Terms: 2% 10, Net 30');
  add('FOB: Destination, freight prepaid');
  drop(8);

  add('Ship To:', { bold: true });
  add('Maple Ridge Industrial Supply, Receiving Door 3, 1450 Fraser Way, Burlington ON L7L 4X3');
  add('Bill To:', { bold: true });
  add('Maple Ridge Industrial Supply - Accounts Payable, PO Box 2205, Burlington ON L7R 3Y2');
  drop(10);

  const cols = [45, 70, 128, 310, 345, 385, 425, 458, 505];
  ['Ln', 'Item', 'Description', 'Qty', 'UM', 'List', 'Disc %', 'Net', 'Extended'].forEach((h, i) =>
    add(h, { bold: true, x: cols[i], y: at(), size: 8 }),
  );
  drop(4);
  add('_'.repeat(105), { size: 8 });
  drop(4);

  lines.forEach((line, i) => {
    const s = spec[i]!;
    [String(line.pos), line.code, line.description, String(line.qty), line.uom, money(s.list), `${s.disc}%`, money(line.price), money(amountOf(line))].forEach(
      (c, j) => add(c, { x: cols[j], y: at(), size: 8 }),
    );
    drop(14);
  });

  drop(2);
  add('_'.repeat(105), { size: 8 });
  drop(6);
  const totals: [string, number, boolean][] = [
    ['Goods subtotal', subtotal, false],
    ['Freight', freight, false],
    ['Fuel surcharge', fuel, false],
    ['HST 13%', hst, false],
    ['TOTAL DUE', due, true],
  ];
  for (const [label, value, bold] of totals) {
    add(label, { bold, x: 380, y: at(), size: 9 });
    add(`CAD ${money(value)}`, { bold, x: 480, y: at(), size: 9 });
    drop(14);
  }
  drop(10);

  add('Early-pay discount 2% if paid within 10 days. Returns subject to a 15% restocking fee.', { size: 8 });
  add('Contact: purchasing@mapleridge-supply.example', { size: 8 });

  return { rows, lines };
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
  /** Grey level of the printed strokes: 20 is a clean fax, higher is a tired photocopy. */
  ink = 20;

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
              this.dot(cx + c * scale + dx, y + r * scale + dy, this.ink);
              if (bold) this.dot(cx + c * scale + dx + 1, y + r * scale + dy, this.ink);
            }
          }
        }
      }
      cx += 6 * scale;
    }
  }

  rule(x1: number, x2: number, y: number, thickness = 2) {
    for (let x = x1; x <= x2; x++) for (let t = 0; t < thickness; t++) this.dot(x, y + t, this.ink);
  }

  /** A rubber stamp: a thick box with two lines of text, in its own lighter ink. */
  stamp(x: number, y: number, w: number, line1: string, line2: string, ink = 110) {
    const own = this.ink;
    this.ink = ink;
    const h = 92;
    for (let t = 0; t < 4; t++) {
      this.rule(x, x + w, y + t, 1);
      this.rule(x, x + w, y + h - t, 1);
      for (let yy = y; yy <= y + h; yy++) {
        this.dot(x + t, yy, ink);
        this.dot(x + w - t, yy, ink);
      }
    }
    this.text(x + 18, y + 14, line1, 4, true);
    this.text(x + 18, y + 56, line2, 3);
    this.ink = own;
  }

  /**
   * Skew the whole page about its centre, as a hurried scan or a phone photo does. Bilinear
   * sampling, so the two-pixel strokes soften instead of stair-stepping into illegibility.
   */
  rotate(deg: number) {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = this.w / 2;
    const cy = this.h / 2;
    const out = new Uint8Array(this.px.length).fill(255);
    const at = (x: number, y: number) => this.px[y * this.w + x]!;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const sx = cos * dx + sin * dy + cx;
        const sy = -sin * dx + cos * dy + cy;
        if (sx < 0 || sy < 0 || sx >= this.w - 1 || sy >= this.h - 1) continue;
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const fx = sx - x0;
        const fy = sy - y0;
        out[y * this.w + x] = Math.round(
          at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy,
        );
      }
    }
    this.px.set(out);
  }

  /** The dark gradient down the left edge where the page lifted off the scanner glass. */
  shadow(width = 46) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * this.w + x;
        this.px[i] = Math.round(this.px[i]! * (0.5 + (0.5 * x) / width));
      }
    }
  }

  /** Toner specks and one faint streak — enough to read as a fax, not enough to obscure. */
  grunge(specks = 1400) {
    for (let i = 0; i < specks; i++) {
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

  return { pdf: imagePagePdf(page), lines };
}

/** The page as a single embedded grayscale image — no text layer anywhere in the file. */
function imagePagePdf(page: FaxPage): Buffer {
  const image = zlib.deflateSync(Buffer.from(page.px));
  const content = Buffer.from('q 595 0 0 842 0 0 cm /Im1 Do Q', 'latin1');

  return assemblePdf([
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
}

/**
 * The same idea as `scan`, made harder: Dutch, a faint photocopy, the whole page turned
 * a couple of degrees, a shadow down the left edge, heavy speckle, and a RECEIVED stamp in
 * the top margin. Nothing on the page is wrong — it is only badly reproduced.
 */
function buildSkewScan(): { pdf: Buffer; lines: Line[] } {
  const spec = [
    { mi: 0, d: 'ZESKANTBOUT M10X40 VERZINKT', qty: 1500, u: 'ST' },
    { mi: 2, d: 'HYDRAULISCHE SLANG 1/2" 2M', qty: 8, u: 'ST' },
    { mi: 3, d: 'INDUSTRIEEL SMEERMIDDEL 20L', qty: 5, u: 'DOOS' },
    { mi: 4, d: 'VEILIGHEIDSKLEP 16 BAR DN25', qty: 3, u: 'ST' },
  ];
  const lines: Line[] = spec.map((s, i) => ({ ...MATERIALS[s.mi]!, description: s.d, uom: s.u, qty: s.qty, pos: i + 1 }));
  const amountOf = (l: Line) => round2(l.qty * l.price);
  const total = round2(lines.reduce((s, l) => s + amountOf(l), 0));

  const page = new FaxPage();
  page.ink = 70;
  const L = 90;
  let y = 150;

  page.text(L, y, 'BROUWER & ZONEN MACHINEBOUW B.V.', 4, true);
  y += 42;
  page.text(L, y, 'INDUSTRIEWEG 114, 3044 AS ROTTERDAM, NEDERLAND', 2);
  y += 24;
  page.text(L, y, 'KVK 24118873   BTW NL806129447B01', 2);
  y += 40;

  page.text(L, y, 'INKOOPORDER', 3, true);
  y += 44;

  const kv: [string, string][] = [
    ['ORDERNR', 'BZ-26-10417'],
    ['ORDERDATUM', '18-09-2026'],
    ['LEVERDATUM', '09-10-2026'],
    ['KLANTNR', 'C-7350'],
    ['VALUTA', 'EUR'],
    ['BETALING', '30 DAGEN NETTO'],
    ['LEVERING', 'DAP ROTTERDAM'],
  ];
  for (const [k, v] of kv) {
    page.text(L, y, `${k}:`, 2, true);
    page.text(L + 190, y, v, 2);
    y += 26;
  }
  y += 12;

  page.text(L, y, 'AFLEVERADRES:', 2, true);
  y += 24;
  page.text(L, y, 'BROUWER & ZONEN, MAGAZIJN 2, INDUSTRIEWEG 114, 3044 AS ROTTERDAM', 2);
  y += 30;
  page.text(L, y, 'FACTUURADRES:', 2, true);
  y += 24;
  page.text(L, y, 'BROUWER & ZONEN, CREDITEURENADMINISTRATIE, POSTBUS 5017, 3008 AA ROTTERDAM', 2);
  y += 40;

  const rowText = (c: string[]) =>
    c[0]!.padEnd(4) + c[1]!.padEnd(11) + c[2]!.padEnd(34) + c[3]!.padStart(6) + '  ' + c[4]!.padEnd(5) + c[5]!.padStart(9) + c[6]!.padStart(12);
  page.text(L, y, rowText(['RG', 'ARTIKEL', 'OMSCHRIJVING', 'AANTAL', 'EENH', 'PRIJS', 'BEDRAG']), 2, true);
  y += 24;
  page.rule(L, page.w - L, y, 2);
  y += 16;

  for (const line of lines) {
    page.text(
      L, y,
      rowText([String(line.pos), line.code, line.description, String(line.qty), line.uom, dotted(line.price), dotted(amountOf(line))]),
      2,
    );
    y += 28;
  }
  y += 4;
  page.rule(L, page.w - L, y, 2);
  y += 20;
  page.text(L + 640, y, `TOTAAL EUR ${dotted(total)}`, 2, true);
  y += 44;

  page.text(L, y, 'BIJ LEVERING ORDERNR VERMELDEN OP PAKBON EN FACTUUR.', 2);
  y += 26;
  page.text(L, y, 'CONTACT: INKOOP@BROUWERMACHINEBOUW.EXAMPLE', 2);

  // The stamp sits in the empty top margin, clear of the figures.
  page.stamp(800, 40, 330, 'ONTVANGEN', '21-09-2026');
  page.rotate(2.2);
  page.shadow();
  page.grunge(7000);

  return { pdf: imagePagePdf(page), lines };
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
} else if (vendor === 'skewscan') {
  ({ pdf, lines } = buildSkewScan());
} else if (vendor === 'multipage') {
  ({ pdf, lines } = buildMultiPage());
} else {
  const built =
    vendor === 'apex' ? buildApex()
    : vendor === 'shakti' ? buildShakti()
    : vendor === 'nordica' ? buildNordica()
    : vendor === 'columns' ? buildColumns()
    : vendor === 'letter' ? buildLetter()
    : vendor === 'bondecommande' ? buildFrench()
    : vendor === 'ordine' ? buildItalian()
    : vendor === 'discounts' ? buildDiscounts()
    : buildClassic(vendor);
  pdf = buildTextPdf(built.rows);
  lines = built.lines;
}

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, pdf);
console.log(`Wrote ${outPath} (${pdf.length} bytes, ${lines.length} line items, vendor: ${vendor})`);
