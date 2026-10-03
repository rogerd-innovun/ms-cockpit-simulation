/**
 * Generates three candidate Sales Order confirmation layouts for the client to choose
 * between. All three carry IDENTICAL data — the same order, the same four lines, the
 * same money — so a side-by-side comparison is a comparison of format alone.
 *
 *   npx tsx scripts/makeSampleSo.ts [outputPath] [--format=<key>]
 *
 * Formats:
 *   classic  ERP-native order confirmation. Dense, formal, labelled key-value header,
 *            one grid row per item, net/freight/tax/total block. What S/4HANA prints.
 *   modern   Customer-facing confirmation. Generous whitespace, the three facts a buyer
 *            actually wants up top, two lines per item instead of a grid, plain language.
 *   compact  Operations/despatch one-pager. Fixed-width Courier, all-caps, ordered-vs-
 *            confirmed quantities, plant/storage location/schedule date per line, and a
 *            despatch and blocks summary. Built for the warehouse, not the buyer.
 *
 * The order shown is the one that flows through the demo: Apex Fastener Supply's PO
 * APX-118276, which becomes SO 4500533926. Seller details are placeholders — change
 * SELLER below to the real selling entity before showing these to anyone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildTextPdf, makeSheet, textWidth, type Row } from './lib/pdfSheet.js';

const SELLER = {
  name: 'Lakeside Manufacturing LLC',
  address: '2400 Matzinger Road, Toledo, OH 43612, USA',
  tax: 'Fed Tax ID 34-2298104',
  web: 'www.lakesidemfg.example',
  email: 'orders@lakesidemfg.example',
  phone: '+1 419 555 0188',
};

const ORDER = {
  soNumber: '4500533926',
  soDate: 'Sep 21, 2026',
  poNumber: 'APX-118276',
  poDate: 'Sep 18, 2026',
  customerName: 'APEX FASTENER SUPPLY INC.',
  customerCode: 'C-3305',
  currency: 'USD',
  terms: 'Net 30',
  incoterms: 'FOB Origin - Freight Collect',
  salesOrg: '1000 / 10 / 00',
  shipTo: [
    'Apex Fastener Supply, Receiving Dock 2',
    '4180 Commerce Drive',
    'Dayton, OH 45402',
    'Attn: J. Alvarez',
  ],
  billTo: [
    'Apex Fastener Supply - Accounts Payable',
    'P.O. Box 9917',
    'Dayton, OH 45401',
  ],
  freight: 145.0,
  tax: 0.0,
};

interface SoLine {
  pos: number;
  material: string;
  customerMaterial: string;
  description: string;
  qty: number;
  confirmed: number;
  uom: string;
  price: number;
  plant: string;
  sloc: string;
  /** Long form for the customer-facing layouts. */
  schedule: string;
  /** Short form for the grid layouts, where the column is narrow. */
  scheduleShort: string;
}

const LINES: SoLine[] = [
  { pos: 10, material: 'MAT-1042', customerMaterial: 'CM-8801', description: 'Hex bolt M10x40 zinc plated', qty: 2500, confirmed: 2500, uom: 'EA', price: 0.42, plant: '1010', sloc: '0001', schedule: 'Oct 02, 2026', scheduleShort: '10/02/26' },
  { pos: 20, material: 'MAT-2318', customerMaterial: 'CM-8802', description: 'Stainless washer DIN125 10mm', qty: 5000, confirmed: 5000, uom: 'EA', price: 0.11, plant: '1010', sloc: '0001', schedule: 'Oct 02, 2026', scheduleShort: '10/02/26' },
  { pos: 30, material: 'MAT-9021', customerMaterial: 'CM-8804', description: 'Industrial lubricant, 20L drum', qty: 12, confirmed: 12, uom: 'BOX', price: 132.0, plant: '1020', sloc: '0002', schedule: 'Oct 09, 2026', scheduleShort: '10/09/26' },
  { pos: 40, material: 'MAT-3390', customerMaterial: 'CM-8805', description: 'Safety valve, 16 bar, DN25', qty: 8, confirmed: 8, uom: 'EA', price: 219.75, plant: '1020', sloc: '0002', schedule: 'Oct 09, 2026', scheduleShort: '10/09/26' },
];

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plain = (n: number) => n.toFixed(2);
const qty = (n: number) => n.toLocaleString('en-US');

const netValue = LINES.reduce((sum, l) => sum + l.qty * l.price, 0);
const grandTotal = netValue + ORDER.freight + ORDER.tax;
const lastSchedule = LINES[LINES.length - 1]!.schedule;

// ------------------------------------------------------------------ A: classic
//
// The ERP printout. Everything labelled, nothing inferred, column grid for the
// items, money stacked bottom-right. Familiar to anyone who has handled an SAP
// order confirmation, and the densest of the three.

function buildClassic(): Row[] {
  const { rows, add, drop, at } = makeSheet();

  add(SELLER.name.toUpperCase(), { size: 16, bold: true });
  add(SELLER.address);
  add(`${SELLER.tax}  ·  ${SELLER.web}`);
  drop(14);

  add('ORDER CONFIRMATION', { size: 14, bold: true });
  drop(8);

  // Two labelled columns: our document on the left, their reference on the right.
  const top = at();
  const pair = (x: number, items: [string, string][]) => {
    let py = top;
    for (const [k, v] of items) {
      rows.push({ text: k, size: 9, bold: false, x, y: py });
      rows.push({ text: v, size: 9, bold: false, x: x + 110, y: py });
      py -= 13;
    }
    return py;
  };
  const left = pair(50, [
    ['Sales Order No.', ORDER.soNumber],
    ['Document Date', ORDER.soDate],
    ['Sales Org.', ORDER.salesOrg],
    ['Currency', ORDER.currency],
  ]);
  const right = pair(310, [
    ['Your PO No.', ORDER.poNumber],
    ['Your PO Date', ORDER.poDate],
    ['Account No.', ORDER.customerCode],
    ['Payment Terms', ORDER.terms],
  ]);
  drop(top - Math.min(left, right) + 8);

  add('Sold-To Party:', { bold: true });
  add(`${ORDER.customerName}, 4180 Commerce Drive, Dayton, OH 45402`);
  add('Ship-To Party:', { bold: true });
  add(ORDER.shipTo.join(', '));
  add(`Incoterms: ${ORDER.incoterms}`);
  drop(12);

  // Text columns are placed from the left; the three numeric ones hang off a right
  // edge so the figures line up on the decimal point the way a ledger should.
  const cols = { item: 50, material: 76, desc: 138, uom: 332, plant: 462, sched: 498 };
  const rightOf = { qty: 326, price: 404, value: 458 };
  const addRight = (text: string, edge: number, opts: Partial<Row> = {}) =>
    add(text, { ...opts, x: edge - textWidth(text, opts.size ?? 9, { bold: opts.bold }), y: at() });

  const head = { bold: true, size: 8 };
  add('Item', { ...head, x: cols.item, y: at() });
  add('Material', { ...head, x: cols.material, y: at() });
  add('Description', { ...head, x: cols.desc, y: at() });
  addRight('Qty', rightOf.qty, head);
  add('UM', { ...head, x: cols.uom, y: at() });
  addRight('Price', rightOf.price, head);
  addRight('Net Value', rightOf.value, head);
  add('Plant', { ...head, x: cols.plant, y: at() });
  add('Conf. Del.', { ...head, x: cols.sched, y: at() });
  drop(4);
  add('_'.repeat(95), { size: 8 });
  drop(6);

  for (const line of LINES) {
    const cell = { size: 8 };
    add(String(line.pos), { ...cell, x: cols.item, y: at() });
    add(line.material, { ...cell, x: cols.material, y: at() });
    add(line.description, { ...cell, x: cols.desc, y: at() });
    addRight(qty(line.qty), rightOf.qty, cell);
    add(line.uom, { ...cell, x: cols.uom, y: at() });
    addRight(money(line.price), rightOf.price, cell);
    addRight(money(line.qty * line.price), rightOf.value, cell);
    add(line.plant, { ...cell, x: cols.plant, y: at() });
    add(line.scheduleShort, { ...cell, x: cols.sched, y: at() });
    drop(14);
  }

  drop(2);
  add('_'.repeat(95), { size: 8 });
  drop(8);

  const totalRow = (label: string, value: string, bold = false) => {
    add(label, { bold, x: 356, y: at(), size: 9 });
    addRight(value, rightOf.value, { bold, size: 9 });
    drop(14);
  };
  totalRow('Net Value', money(netValue));
  totalRow('Freight', money(ORDER.freight));
  totalRow('Tax', money(ORDER.tax));
  totalRow(`Total ${ORDER.currency}`, money(grandTotal), true);
  drop(16);

  add('All items confirmed as scheduled above. Partial shipment permitted.', { size: 8 });
  add(`Please quote Sales Order ${ORDER.soNumber} on all correspondence and delivery queries.`, { size: 8 });
  add(`${SELLER.email}  ·  ${SELLER.phone}`, { size: 8 });

  return rows;
}

// ------------------------------------------------------------------- B: modern
//
// Written for the person who opens the email, not the person who files it. The
// three facts a buyer checks first are lifted out of the body and set large; the
// items drop the grid for two lines each, so long descriptions are never clipped.

function buildModern(): Row[] {
  const { rows, add, drop, at } = makeSheet();

  add('Lakeside Manufacturing', { size: 13, bold: true });
  drop(26);

  add('Order confirmed', { size: 22, bold: true });
  drop(6);
  add('Thanks - we have your order and everything is in stock and scheduled.', { size: 10 });
  drop(26);

  // Three facts, set large, each under a small caps label.
  const factTop = at();
  const fact = (x: number, label: string, value: string) => {
    rows.push({ text: label, size: 7, bold: true, x, y: factTop });
    rows.push({ text: value, size: 14, bold: true, x, y: factTop - 20 });
  };
  fact(50, 'SALES ORDER', ORDER.soNumber);
  fact(230, 'ORDER TOTAL', `${ORDER.currency} ${money(grandTotal)}`);
  fact(410, 'ARRIVING BY', lastSchedule);
  drop(46);

  add(`Against your purchase order ${ORDER.poNumber} of ${ORDER.poDate}.`, { size: 9 });
  drop(26);

  add('WHAT YOU ORDERED', { size: 7, bold: true });
  drop(10);
  add('_'.repeat(88), { size: 8 });
  drop(12);

  const MONEY_EDGE = 520;
  const addRight = (text: string, opts: Partial<Row> = {}) =>
    add(text, { ...opts, x: MONEY_EDGE - textWidth(text, opts.size ?? 9, { bold: opts.bold }), y: at() });

  for (const line of LINES) {
    add(line.description, { size: 10, bold: true, x: 50, y: at() });
    addRight(money(line.qty * line.price), { size: 10, bold: true });
    drop(13);
    add(
      `${line.material}  ·  ${qty(line.qty)} ${line.uom} at ${money(line.price)}  ·  arrives ${line.schedule}`,
      { size: 8, x: 50, y: at() },
    );
    drop(20);
  }

  add('_'.repeat(88), { size: 8 });
  drop(12);

  const totalRow = (label: string, value: string, bold = false) => {
    add(label, { bold, x: 370, y: at(), size: 9 });
    addRight(value, { bold, size: 9 });
    drop(14);
  };
  totalRow('Subtotal', money(netValue));
  totalRow('Freight', money(ORDER.freight));
  totalRow('Tax', money(ORDER.tax));
  totalRow(`Total ${ORDER.currency}`, money(grandTotal), true);
  drop(24);

  // Delivery and payment side by side, each a plain block of lines.
  const blockTop = at();
  const block = (x: number, title: string, body: string[]) => {
    rows.push({ text: title, size: 7, bold: true, x, y: blockTop });
    let by = blockTop - 15;
    for (const b of body) {
      rows.push({ text: b, size: 9, bold: false, x, y: by });
      by -= 12;
    }
    return by;
  };
  const b1 = block(50, 'DELIVERING TO', ORDER.shipTo);
  const b2 = block(310, 'PAYMENT', [
    `${ORDER.terms} from invoice date`,
    ORDER.incoterms,
    'Invoiced to:',
    ...ORDER.billTo,
  ]);
  drop(blockTop - Math.min(b1, b2) + 18);

  add(`Questions about this order? ${SELLER.email}  ·  ${SELLER.phone}`, { size: 8 });

  return rows;
}

// ------------------------------------------------------------------ C: compact
//
// The despatch desk's copy. Fixed-width Courier throughout, uppercase, and the
// columns operations actually act on: ordered vs confirmed quantity, plant,
// storage location, schedule date, plus weights and the block status that tells
// them whether it can ship at all. Fits far more on the page than the other two.

function buildCompact(): Row[] {
  const { rows, add, drop, at } = makeSheet();
  const M = { mono: true } as const;

  // One column count governs the whole sheet: the banner, both rules, the item grid
  // and the right-aligned totals all measure exactly this wide, which is what makes a
  // fixed-width report look machine-printed rather than hand-placed.
  const GRID = 92;
  const S = 7;
  const gridWidth = GRID * 0.6 * S;
  const addRight = (text: string, size: number, bold = false) =>
    add(text, { size, bold, ...M, x: 50 + gridWidth - textWidth(text, size, { mono: true }), y: at() });

  const banner = (left: string, centre: string, right: string) => {
    const slack = GRID - left.length - centre.length - right.length;
    const lead = Math.max(1, Math.floor(slack / 2));
    return left + ' '.repeat(lead) + centre + ' '.repeat(Math.max(1, slack - lead)) + right;
  };

  add(banner('LAKESIDE MFG', 'ORDER CONFIRMATION / DESPATCH ADVICE', 'PAGE 1 OF 1'), {
    size: S,
    bold: true,
    ...M,
  });
  drop(4);
  add('='.repeat(GRID), { size: S, ...M });
  drop(10);

  const kv = (pairs: [string, string][], x: number, startY: number) => {
    let py = startY;
    for (const [k, v] of pairs) {
      rows.push({ text: k.padEnd(11) + v, size: 8, bold: false, x, y: py, mono: true });
      py -= 12;
    }
    return py;
  };
  const top = at();
  const l = kv(
    [
      ['SO NO', ORDER.soNumber],
      ['SO DATE', ORDER.soDate.toUpperCase()],
      ['CUST PO', ORDER.poNumber],
      ['PO DATE', ORDER.poDate.toUpperCase()],
    ],
    50,
    top,
  );
  const r = kv(
    [
      ['CUST NO', ORDER.customerCode],
      ['SALES ORG', ORDER.salesOrg.replace(/ /g, '')],
      ['CURRENCY', ORDER.currency],
      ['TERMS', `${ORDER.terms.toUpperCase()} / FOB ORIGIN`],
    ],
    310,
    top,
  );
  drop(top - Math.min(l, r) + 8);

  add(`SHIP TO   APEX FASTENER SUPPLY / DOCK 2 / 4180 COMMERCE DR`, { size: 8, ...M });
  add(`          DAYTON OH 45402 / ATTN J ALVAREZ`, { size: 8, ...M });
  add(`BILL TO   APEX FASTENER SUPPLY AP / PO BOX 9917 / DAYTON OH 45401`, { size: 8, ...M });
  drop(12);

  // Courier is fixed-width, so one padded string per row keeps the grid true. The
  // widths below sum to GRID; DESCRIPTION is 31 so the longest material description
  // lands whole rather than clipped mid-word.
  const gridRow = (c: string[]) =>
    c[0]!.padEnd(4) +
    c[1]!.padEnd(10) +
    c[2]!.padEnd(9) +
    c[3]!.padEnd(31) +
    c[4]!.padStart(6) +
    c[5]!.padStart(6) +
    ' ' +
    c[6]!.padEnd(4) +
    c[7]!.padEnd(5) +
    c[8]!.padEnd(5) +
    c[9]!.padStart(11);

  add(
    gridRow(['ITM', 'MATERIAL', 'CUST-MAT', 'DESCRIPTION', 'ORD', 'CNF', 'UM', 'PLNT', 'SLOC', 'VALUE']),
    { size: S, bold: true, ...M },
  );
  drop(3);
  add('-'.repeat(GRID), { size: S, ...M });
  drop(11);

  for (const line of LINES) {
    add(
      gridRow([
        String(line.pos).padStart(3, '0'),
        line.material,
        line.customerMaterial,
        line.description.toUpperCase().slice(0, 30),
        String(line.qty),
        String(line.confirmed),
        line.uom,
        line.plant,
        line.sloc,
        plain(line.qty * line.price),
      ]),
      { size: S, ...M },
    );
    drop(11);
    add(`    SCHED LINE 0001   CONFIRMED ${line.confirmed} ${line.uom}   GI ${line.scheduleShort}   ROUTE US0001`, {
      size: S,
      ...M,
    });
    drop(13);
  }

  add('-'.repeat(GRID), { size: S, ...M });
  drop(11);
  addRight(
    `LINES ${LINES.length}   NET ${plain(netValue)}   FRT ${plain(ORDER.freight)}   TAX ${plain(ORDER.tax)}`,
    S,
  );
  drop(12);
  addRight(`TOTAL ${ORDER.currency} ${plain(grandTotal)}`, 9, true);
  drop(22);

  add('='.repeat(GRID), { size: S, ...M });
  drop(11);
  add('DESPATCH  GROSS WT 412.600 KG   NET WT 389.000 KG   VOL 1.240 M3   PALLETS 3', { size: S, ...M });
  add('HANDLING  3 HANDLING UNITS   SHIP COND 02 STANDARD   ROUTE US0001   INCO FOB', { size: S, ...M });
  add('BLOCKS    CREDIT OK   DELIVERY NONE   BILLING NONE   COMPLETE DLV NOT REQUIRED', { size: S, ...M });
  drop(14);
  add(`QUERIES   ${SELLER.email.toUpperCase()}   ${SELLER.phone}`, { size: S, ...M });

  return rows;
}

// --------------------------------------------------------------------- main

const FORMAT_KEYS = ['classic', 'modern', 'compact'] as const;
type FormatKey = (typeof FORMAT_KEYS)[number];

const args = process.argv.slice(2);
const formatArg = args.find((a) => a.startsWith('--format='))?.split('=')[1] ?? 'classic';
if (!(FORMAT_KEYS as readonly string[]).includes(formatArg)) {
  console.error(`Unknown format "${formatArg}". Pick one of: ${FORMAT_KEYS.join(', ')}`);
  process.exit(1);
}
const format = formatArg as FormatKey;
const outPath = args.find((a) => !a.startsWith('--')) ?? `sample-so-${format}.pdf`;

const rows =
  format === 'modern' ? buildModern() : format === 'compact' ? buildCompact() : buildClassic();
const pdf = buildTextPdf(rows);

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, pdf);
console.log(
  `Wrote ${outPath} (${pdf.length} bytes, ${LINES.length} items, total ${ORDER.currency} ${money(grandTotal)}, format: ${format})`,
);
