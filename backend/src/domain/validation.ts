import type { POHeader, POLineItem } from '@prisma/client';
import {
  HEADER_LABELS,
  LINE_LABELS,
  REQUIRED_HEADER_FIELDS,
  REQUIRED_LINE_FIELDS,
  headerFieldPath,
  lineFieldPath,
  type HeaderField,
  type LineField,
} from './types.js';

export type Severity = 'BLOCKING' | 'WARNING';

export interface ValidationIssue {
  code: string;
  severity: Severity;
  fieldPath: string;
  message: string;
}

/** FR-6.6 — tolerance on the header-total vs. sum-of-lines reconciliation. */
const TOTAL_TOLERANCE = 0.01;

const ISO_4217 = /^[A-Z]{3}$/;

/**
 * FR-5.8 — the canonical form of a numeric string written in either convention: digits,
 * an optional leading minus and a "." decimal point, no grouping. Null when it cannot be
 * read, rather than guessing.
 *
 * "1,234.56" and "1.234,56" both mean the same thing; which one a vendor uses is not
 * something we get to choose, so the decimal separator is whichever one appears last.
 * A separator that repeats on its own ("1.234.567", "1,23,456") can only be grouping.
 * The fraction digits are kept as written ("1,599.50" stays "1599.50"), because that is
 * what goes to SAP.
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

/**
 * A lone separator followed by exactly three digits ("1,234", "1.234") is either a
 * thousands mark or a three-place decimal, and nothing in the text says which. It is
 * read as a decimal; the reviewer is asked to confirm, because guessing wrong turns a
 * quantity of 1,000 into 1.
 */
export function isAmbiguousDecimal(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  return /^-?[1-9]\d{0,2}[.,]\d{3}$/.test(raw.replace(/[^\d,.\-]/g, ''));
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const WEEKDAYS = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*$/;

/** A real calendar date at UTC midnight, or null — Date.UTC alone rolls 31 Feb into March. */
function utcDate(y: number, m: number, d: number): Date | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt : null;
}

/**
 * Reads the forms purchase orders are actually written in: ISO, Y/M/D, D/M/Y with . / -
 * (day first), compact YYYYMMDD, and month names in either order ("17 Sep 2026",
 * "September 17, 2026", "17-SEP-2026"). Anything else is null, and so is an impossible
 * date. There is deliberately no fallback to `new Date(text)`: it reads non-ISO text in
 * the server's local timezone, so the same PO would give different dates on different hosts.
 */
export function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s) ?? /^(\d{4})[./](\d{1,2})[./](\d{1,2})$/.exec(s);
  if (iso) return utcDate(+iso[1]!, +iso[2]!, +iso[3]!);

  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (compact) return utcDate(+compact[1]!, +compact[2]!, +compact[3]!);

  const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
  if (dmy) return utcDate(+dmy[3]!, +dmy[2]!, +dmy[1]!);

  const tokens = s
    .toLowerCase()
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .split(/[\s,./-]+/)
    .filter((t) => t && !WEEKDAYS.test(t));
  if (tokens.length !== 3) return null;
  const monthIdx = tokens.findIndex((t) => /^[a-z]{3,}$/.test(t));
  const month = monthIdx === -1 ? -1 : MONTH_NAMES.findIndex((m) => m.startsWith(tokens[monthIdx]!));
  if (month === -1) return null;
  const rest = tokens.filter((_, i) => i !== monthIdx);
  const year = rest.find((t) => /^\d{4}$/.test(t));
  const day = rest.find((t) => t !== year && /^\d{1,2}$/.test(t));
  if (!year || !day) return null;
  return utcDate(+year, month + 1, +day);
}

/**
 * "03/04/2026" is 3 April in most of the world and 4 March in the US. It is read day
 * first; when both readings are valid and differ, the reviewer is asked to confirm.
 */
export function isAmbiguousDate(raw: string | null | undefined): boolean {
  const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec((raw ?? '').trim());
  if (!m) return false;
  const a = +m[1]!;
  const b = +m[2]!;
  return a <= 12 && b <= 12 && a !== b;
}

/**
 * A numeric date with a first part above 12 ("18/09/2026") can only be day first. One of
 * those anywhere on the order shows how the whole document writes its dates, so the other
 * numeric dates on it ("05/10/2026") are not really in doubt and should not each ask for
 * a decision.
 */
export function documentProvesDayFirst(dates: (string | null | undefined)[]): boolean {
  return dates.some((raw) => {
    const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec((raw ?? '').trim());
    return !!m && +m[1]! > 12 && +m[2]! <= 12;
  });
}

export type DateFormat = 'iso' | 'yyyymmdd' | 'dd.mm.yyyy';

/** A parsed date written out in the configured form (CSV_DATE_FORMAT). */
export function formatDate(d: Date, format: DateFormat): string {
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  if (format === 'yyyymmdd') return `${y}${m}${day}`;
  if (format === 'dd.mm.yyyy') return `${day}.${m}.${y}`;
  return `${y}-${m}-${day}`;
}

const isBlank = (v: string | null | undefined) => v == null || v.trim() === '';

const ambiguousNumber = (fieldPath: string, label: string, raw: string): ValidationIssue => ({
  code: 'AMBIGUOUS_NUMBER',
  severity: 'WARNING',
  fieldPath,
  message: `${label} "${raw}" could be ${normaliseDecimal(raw)} or ${raw.replace(/[^\d\-]/g, '')}. It is read as ${normaliseDecimal(raw)}; check the PDF.`,
});

export type HeaderWithLines = POHeader & { lineItems: POLineItem[] };

/**
 * FR-6 — structural and format validation.
 *
 * FR-6.3 to FR-6.5 (master-data lookups for customer code, material code and UOM) are
 * deferred to milestone 2; `masterData` is the seam they plug into. Until then those
 * fields are format-checked only, which is why OQ-11 matters.
 */
export interface MasterDataChecker {
  customerExists(code: string): Promise<boolean>;
  materialExists(code: string): Promise<boolean>;
  normaliseUom(uom: string): Promise<{ valid: boolean; suggestion?: string }>;
}

export async function validateRecord(
  header: HeaderWithLines | null,
  masterData?: MasterDataChecker,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  if (!header) {
    return [
      {
        code: 'NO_DATA',
        severity: 'BLOCKING',
        fieldPath: 'header',
        message: 'No extracted data on this record yet.',
      },
    ];
  }

  // --- Header: required fields ---
  for (const field of REQUIRED_HEADER_FIELDS) {
    if (isBlank(header[field as HeaderField] as string | null)) {
      issues.push({
        code: 'REQUIRED_MISSING',
        severity: 'BLOCKING',
        fieldPath: headerFieldPath(field),
        message: `${HEADER_LABELS[field]} is required.`,
      });
    }
  }

  // --- Header: formats ---
  if (!isBlank(header.currency) && !ISO_4217.test(header.currency!.trim().toUpperCase())) {
    issues.push({
      code: 'INVALID_CURRENCY',
      severity: 'BLOCKING',
      fieldPath: headerFieldPath('currency'),
      message: `"${header.currency}" is not a 3-letter ISO 4217 currency code.`,
    });
  }

  const dayFirstProven = documentProvesDayFirst([
    header.poDate,
    header.requestedDeliveryDate,
    ...header.lineItems.map((l) => l.deliveryDate),
  ]);

  for (const field of ['poDate', 'requestedDeliveryDate'] as const) {
    const raw = header[field];
    if (!isBlank(raw) && !parseDate(raw)) {
      issues.push({
        code: 'INVALID_DATE',
        severity: 'BLOCKING',
        fieldPath: headerFieldPath(field),
        message: `${HEADER_LABELS[field]} "${raw}" could not be read as a date.`,
      });
    } else if (!dayFirstProven && isAmbiguousDate(raw)) {
      issues.push({
        code: 'AMBIGUOUS_DATE',
        severity: 'WARNING',
        fieldPath: headerFieldPath(field),
        message: `${HEADER_LABELS[field]} "${raw}" is read day first (${formatDate(parseDate(raw)!, 'iso')}). Check the PDF if it may be month first.`,
      });
    }
  }

  // The figures that go to SAP must be readable as numbers; a blank is allowed, text is not.
  if (!isBlank(header.poTotalValue)) {
    if (parseDecimal(header.poTotalValue) === null) {
      issues.push({
        code: 'INVALID_NUMBER',
        severity: 'BLOCKING',
        fieldPath: headerFieldPath('poTotalValue'),
        message: `${HEADER_LABELS.poTotalValue} "${header.poTotalValue}" is not a number.`,
      });
    } else if (isAmbiguousDecimal(header.poTotalValue)) {
      issues.push(ambiguousNumber(headerFieldPath('poTotalValue'), HEADER_LABELS.poTotalValue, header.poTotalValue!));
    }
  }

  const poDate = parseDate(header.poDate);
  const delivery = parseDate(header.requestedDeliveryDate);
  if (poDate && delivery && delivery < poDate) {
    issues.push({
      code: 'DELIVERY_BEFORE_PO_DATE',
      severity: 'WARNING',
      fieldPath: headerFieldPath('requestedDeliveryDate'),
      message: 'Requested delivery date falls before the PO date.',
    });
  }

  if (poDate) {
    const yearAhead = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    if (poDate > yearAhead) {
      issues.push({
        code: 'IMPLAUSIBLE_DATE',
        severity: 'WARNING',
        fieldPath: headerFieldPath('poDate'),
        message: 'PO date is more than a year in the future.',
      });
    }
  }

  // FR-6.3 — customer code against master data
  if (masterData && !isBlank(header.customerCode)) {
    if (!(await masterData.customerExists(header.customerCode!.trim()))) {
      issues.push({
        code: 'UNKNOWN_CUSTOMER',
        severity: 'BLOCKING',
        fieldPath: headerFieldPath('customerCode'),
        message: `Customer "${header.customerCode}" was not found in SAP master data.`,
      });
    }
  }

  // --- Line items ---
  const lines = [...header.lineItems].sort((a, b) => a.lineNumber - b.lineNumber);

  if (lines.length === 0) {
    issues.push({
      code: 'NO_LINE_ITEMS',
      severity: 'BLOCKING',
      fieldPath: 'lineItems',
      message: 'A Sales Order needs at least one line item.',
    });
  }

  let lineSum = 0;
  let allLineValuesKnown = lines.length > 0;

  for (const line of lines) {
    for (const field of REQUIRED_LINE_FIELDS) {
      if (isBlank(line[field as LineField] as string | null)) {
        issues.push({
          code: 'REQUIRED_MISSING',
          severity: 'BLOCKING',
          fieldPath: lineFieldPath(line.lineNumber, field),
          message: `Line ${line.lineNumber}: ${LINE_LABELS[field]} is required.`,
        });
      }
    }

    const qty = parseDecimal(line.quantity);
    if (line.quantity != null && !isBlank(line.quantity) && qty === null) {
      issues.push({
        code: 'INVALID_NUMBER',
        severity: 'BLOCKING',
        fieldPath: lineFieldPath(line.lineNumber, 'quantity'),
        message: `Line ${line.lineNumber}: quantity "${line.quantity}" is not a number.`,
      });
    } else if (qty !== null && qty <= 0) {
      issues.push({
        code: 'QUANTITY_NOT_POSITIVE',
        severity: 'BLOCKING',
        fieldPath: lineFieldPath(line.lineNumber, 'quantity'),
        message: `Line ${line.lineNumber}: quantity must be greater than zero.`,
      });
    }

    for (const field of ['unitPrice', 'lineNetValue'] as const) {
      const raw = line[field];
      if (isBlank(raw)) continue;
      if (parseDecimal(raw) === null) {
        issues.push({
          code: 'INVALID_NUMBER',
          severity: 'BLOCKING',
          fieldPath: lineFieldPath(line.lineNumber, field),
          message: `Line ${line.lineNumber}: ${LINE_LABELS[field].toLowerCase()} "${raw}" is not a number.`,
        });
      }
    }
    for (const field of ['quantity', 'unitPrice', 'lineNetValue'] as const) {
      if (isAmbiguousDecimal(line[field]) && parseDecimal(line[field]) !== null) {
        issues.push(
          ambiguousNumber(
            lineFieldPath(line.lineNumber, field),
            `Line ${line.lineNumber}: ${LINE_LABELS[field].toLowerCase()}`,
            line[field]!,
          ),
        );
      }
    }
    if (!isBlank(line.deliveryDate)) {
      if (!parseDate(line.deliveryDate)) {
        issues.push({
          code: 'INVALID_DATE',
          severity: 'BLOCKING',
          fieldPath: lineFieldPath(line.lineNumber, 'deliveryDate'),
          message: `Line ${line.lineNumber}: delivery date "${line.deliveryDate}" could not be read as a date.`,
        });
      } else if (!dayFirstProven && isAmbiguousDate(line.deliveryDate)) {
        issues.push({
          code: 'AMBIGUOUS_DATE',
          severity: 'WARNING',
          fieldPath: lineFieldPath(line.lineNumber, 'deliveryDate'),
          message: `Line ${line.lineNumber}: delivery date "${line.deliveryDate}" is read day first (${formatDate(parseDate(line.deliveryDate)!, 'iso')}). Check the PDF if it may be month first.`,
        });
      }
    }

    const price = parseDecimal(line.unitPrice);
    if (price !== null && price < 0) {
      issues.push({
        code: 'PRICE_NEGATIVE',
        severity: 'BLOCKING',
        fieldPath: lineFieldPath(line.lineNumber, 'unitPrice'),
        message: `Line ${line.lineNumber}: unit price cannot be negative.`,
      });
    }

    // FR-6.6 — line arithmetic cross-check
    const net = parseDecimal(line.lineNetValue);
    if (net === null) allLineValuesKnown = false;
    else lineSum += net;

    if (qty !== null && price !== null && net !== null) {
      const expected = qty * price;
      if (Math.abs(expected - net) > Math.max(TOTAL_TOLERANCE, expected * 0.005)) {
        issues.push({
          code: 'LINE_MATH_MISMATCH',
          severity: 'WARNING',
          fieldPath: lineFieldPath(line.lineNumber, 'lineNetValue'),
          message: `Line ${line.lineNumber}: quantity × unit price = ${expected.toFixed(
            2,
          )}, but net value reads ${net.toFixed(2)}.`,
        });
      }
    }

    // FR-6.3 / FR-6.4 — material and UOM against master data
    if (masterData && !isBlank(line.materialCode)) {
      if (!(await masterData.materialExists(line.materialCode!.trim()))) {
        issues.push({
          code: 'UNKNOWN_MATERIAL',
          severity: 'BLOCKING',
          fieldPath: lineFieldPath(line.lineNumber, 'materialCode'),
          message: `Line ${line.lineNumber}: material "${line.materialCode}" was not found in SAP master data.`,
        });
      }
    }
    if (masterData && !isBlank(line.uom)) {
      const uom = await masterData.normaliseUom(line.uom!.trim());
      if (!uom.valid) {
        issues.push({
          code: 'UNKNOWN_UOM',
          severity: uom.suggestion ? 'WARNING' : 'BLOCKING',
          fieldPath: lineFieldPath(line.lineNumber, 'uom'),
          message: uom.suggestion
            ? `Line ${line.lineNumber}: UOM "${line.uom}" is not an SAP unit — did you mean "${uom.suggestion}"?`
            : `Line ${line.lineNumber}: UOM "${line.uom}" is not a recognised SAP unit.`,
        });
      }
    }
  }

  // FR-6.6 — header total vs. sum of lines
  const total = parseDecimal(header.poTotalValue);
  if (total !== null && allLineValuesKnown && lines.length > 0) {
    if (Math.abs(total - lineSum) > Math.max(TOTAL_TOLERANCE, total * 0.005)) {
      issues.push({
        code: 'TOTAL_MISMATCH',
        severity: 'WARNING',
        fieldPath: headerFieldPath('poTotalValue'),
        message: `Line items sum to ${lineSum.toFixed(2)} but the PO total reads ${total.toFixed(
          2,
        )}.`,
      });
    }
  }

  return issues;
}

export const blockingIssues = (issues: ValidationIssue[]) =>
  issues.filter((i) => i.severity === 'BLOCKING');
