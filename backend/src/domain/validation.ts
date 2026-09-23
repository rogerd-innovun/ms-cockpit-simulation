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
 * FR-5.8 — normalise a numeric string written in either convention.
 * "1,234.56" and "1.234,56" both mean the same thing; which one a vendor uses is not
 * something we get to choose, so decide from whichever separator appears last.
 */
export function parseDecimal(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = raw.replace(/[^\d,.\-]/g, '').trim();
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let normalised: string;
  if (lastComma === -1 && lastDot === -1) normalised = s;
  else if (lastComma > lastDot) normalised = s.replace(/\./g, '').replace(',', '.');
  else normalised = s.replace(/,/g, '');
  const n = Number(normalised);
  return Number.isFinite(n) ? n : null;
}

/** Accepts ISO and the common European/US written forms. */
export function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    const d = new Date(Date.UTC(+iso[1]!, +iso[2]! - 1, +iso[3]!));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
  if (dmy) {
    const d = new Date(Date.UTC(+dmy[3]!, +dmy[2]! - 1, +dmy[1]!));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const isBlank = (v: string | null | undefined) => v == null || v.trim() === '';

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

  for (const field of ['poDate', 'requestedDeliveryDate'] as const) {
    const raw = header[field];
    if (!isBlank(raw) && !parseDate(raw)) {
      issues.push({
        code: 'INVALID_DATE',
        severity: 'BLOCKING',
        fieldPath: headerFieldPath(field),
        message: `${HEADER_LABELS[field]} "${raw}" could not be read as a date.`,
      });
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
