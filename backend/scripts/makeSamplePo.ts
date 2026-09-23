/**
 * Generates a realistic single-page PO PDF with no PDF dependency, so the lifecycle can
 * be exercised without hunting for a real customer document. The output is a genuine
 * text-bearing PDF, which means Gemini can actually read it — useful for checking the
 * real extraction path, not just the mock.
 *
 *   npx tsx scripts/makeSamplePo.ts [outputPath] [--vendor=northwind|mock]
 */
import fs from 'node:fs';
import path from 'node:path';

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

function escapePdf(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

type Row = { text: string; size: number; bold: boolean; y: number; x: number };

function buildRows(vendor: 'mock' | 'northwind'): { rows: Row[]; lines: Line[] } {
  const rows: Row[] = [];
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

  let y = 800;
  const add = (text: string, opts: Partial<Row> = {}) => {
    rows.push({ text, size: opts.size ?? 9, bold: opts.bold ?? false, y: opts.y ?? y, x: opts.x ?? 50 });
    if (opts.y === undefined) y -= opts.size ? opts.size + 4 : 13;
  };

  add(vendorName, { size: 16, bold: true });
  add(german ? 'Werkstrasse 14, 40213 Düsseldorf, Deutschland' : '22 Harbour Road, Bristol BS1 5TY, United Kingdom');
  add(german ? `USt-IdNr. ${taxId}` : `VAT Reg. ${taxId}`);
  y -= 14;

  add(german ? 'BESTELLUNG / PURCHASE ORDER' : 'PURCHASE ORDER', { size: 14, bold: true });
  y -= 6;

  add(german ? `Bestellnummer: ${poNumber}` : `Order Ref: ${poNumber}`, { bold: true });
  add(german ? `Bestelldatum: ${poDate}` : `Order Date: ${poDate}`);
  add(german ? `Lieferdatum: ${delivery}` : `Required By: ${delivery}`);
  add(german ? `Kundennummer: ${customerCode}` : `Account No: ${customerCode}`);
  add(german ? 'Währung: EUR' : 'Currency: GBP');
  add(german ? 'Zahlungsbedingungen: 30 Tage netto' : 'Payment Terms: Net 45');
  add(german ? 'Incoterms: DAP Düsseldorf' : 'Incoterms: FCA Bristol');
  y -= 8;

  add(german ? 'Lieferadresse:' : 'Deliver To:', { bold: true });
  add(german ? 'Werk Nord, Tor 3, Industriestrasse 88, 40468 Düsseldorf' : 'Unit 7, Avonmouth Distribution Park, Bristol BS11 9YP');
  add(german ? 'Rechnungsadresse:' : 'Invoice To:', { bold: true });
  add(german ? 'Postfach 220, 40213 Düsseldorf' : 'Accounts Payable, 22 Harbour Road, Bristol BS1 5TY');
  y -= 10;

  // Table header
  const cols = [50, 85, 150, 330, 385, 420, 480];
  const headers = german
    ? ['Pos.', 'Artikelnr.', 'Bezeichnung', 'Menge', 'ME', 'Preis', 'Betrag']
    : ['Line', 'Code', 'Description', 'Qty', 'UOM', 'Price', 'Amount'];
  headers.forEach((h, i) => add(h, { bold: true, x: cols[i], y }));
  y -= 4;
  add('_'.repeat(95), { size: 8 });
  y -= 4;

  let total = 0;
  for (const line of lines) {
    const amount = line.qty * line.price;
    total += amount;
    const codeCell = german ? line.customerCode : line.code;
    const descCell = german ? `${line.description} (${line.code})` : line.description;
    const cells = [
      String(line.pos),
      codeCell,
      descCell,
      String(line.qty),
      line.uom,
      money(line.price),
      money(amount),
    ];
    cells.forEach((c, i) => add(c, { x: cols[i], y }));
    y -= 14;
  }

  y -= 2;
  add('_'.repeat(95), { size: 8 });
  y -= 6;
  add(german ? 'Gesamtsumme' : 'Order Total', { bold: true, x: 330, y });
  add(`${german ? 'EUR' : 'GBP'} ${money(total)}`, { bold: true, x: 420, y });
  y -= 24;

  // Rows that are deliberately NOT line items — the prompt has to exclude them.
  if (!german) {
    add('Carriage and handling charged separately at cost.', { size: 8 });
  } else {
    add('Verpackung und Fracht werden gesondert berechnet.', { size: 8 });
  }
  add(german ? 'Kontakt: einkauf@mock-industries.example' : 'Contact: purchasing@northwind-trading.example', { size: 8 });

  return { rows, lines };
}

function buildPdf(rows: Row[]): Buffer {
  const content = rows
    .map(
      (r) =>
        `BT /${r.bold ? 'F2' : 'F1'} ${r.size} Tf 1 0 0 1 ${r.x} ${r.y} Tm (${escapePdf(r.text)}) Tj ET`,
    )
    .join('\n');

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

const args = process.argv.slice(2);
const vendorArg = args.find((a) => a.startsWith('--vendor='))?.split('=')[1];
const vendor: 'mock' | 'northwind' = vendorArg === 'northwind' ? 'northwind' : 'mock';
const outPath = args.find((a) => !a.startsWith('--')) ?? `sample-po-${vendor}.pdf`;

const { rows, lines } = buildRows(vendor);
const pdf = buildPdf(rows);
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, pdf);
console.log(`Wrote ${outPath} (${pdf.length} bytes, ${lines.length} line items, vendor: ${vendor})`);
