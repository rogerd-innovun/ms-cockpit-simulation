import { env } from '../../config/env.js';
import type { HeaderWithLines } from '../../domain/validation.js';

/**
 * FR-9.2 / docs/01-requirements.md §8.2.
 *
 * PROVISIONAL until OQ-03 closes. Both candidate layouts are implemented and chosen by
 * CSV_LAYOUT, so confirming the real schema with the SAP team is a config change rather
 * than a rewrite (FR-9.3). If the existing job parses positionally, column ORDER here is
 * the contract — changing it is a breaking change (IC-07).
 */

export const HEADER_COLUMNS = [
  'REC_TYPE',
  'CORRELATION_ID',
  'ATTEMPT',
  'PO_NUMBER',
  'PO_DATE',
  'CUSTOMER_CODE',
  'CUSTOMER_NAME',
  'SHIP_TO',
  'BILL_TO',
  'CURRENCY',
  'REQUESTED_DELIVERY_DATE',
  'PAYMENT_TERMS',
  'INCOTERMS',
  'PO_TOTAL_VALUE',
] as const;

export const LINE_COLUMNS = [
  'REC_TYPE',
  'CORRELATION_ID',
  'ATTEMPT',
  'LINE_NUMBER',
  'MATERIAL_CODE',
  'CUSTOMER_MATERIAL_NUMBER',
  'DESCRIPTION',
  'QUANTITY',
  'UOM',
  'UNIT_PRICE',
  'LINE_NET_VALUE',
  'LINE_DELIVERY_DATE',
  'PLANT',
] as const;

/**
 * FR-9.4 — escape delimiters and quotes occurring inside values.
 *
 * Newlines are collapsed to a space rather than quoted. RFC 4180 allows a quoted field
 * to span physical lines, but the consuming job is an existing SAP-side reader whose
 * parser we do not control (IC-01, OQ-08), and a line-by-line reader would see a
 * multi-line address as a truncated record followed by a garbage one. Losing the line
 * breaks in a ship-to address costs nothing; silently splitting a record costs a wrong
 * Sales Order. One physical line per record is the safer contract until OQ-03 confirms
 * the job can handle embedded newlines.
 */
export function csvEscape(value: string | null | undefined): string {
  const s = (value ?? '').replace(/\r\n|\r|\n/g, ' ').replace(/\s+/g, ' ').trim();
  const d = env.CSV_DELIMITER;
  if (s.includes(d) || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const row = (cells: (string | null | undefined)[]) =>
  cells.map(csvEscape).join(env.CSV_DELIMITER);

export interface OutboundPayload {
  /** Filename suffix → file contents. */
  files: { suffix: string; content: string }[];
}

export function buildOutboundPayload(
  correlationId: string,
  attempt: number,
  header: HeaderWithLines,
): OutboundPayload {
  const attemptStr = String(attempt);
  const lines = [...header.lineItems].sort((a, b) => a.lineNumber - b.lineNumber);

  // IC-06 — the correlation ID appears on every row, so a line can never be orphaned
  // from its header.
  const headerCells = [
    'H',
    correlationId,
    attemptStr,
    header.poNumber,
    header.poDate,
    header.customerCode,
    header.customerName,
    header.shipTo,
    header.billTo,
    header.currency,
    header.requestedDeliveryDate,
    header.paymentTerms,
    header.incoterms,
    header.poTotalValue,
  ];

  const lineRows = lines.map((l) =>
    row([
      'L',
      correlationId,
      attemptStr,
      String(l.lineNumber),
      l.materialCode,
      l.customerMaterialNumber,
      l.description,
      l.quantity,
      l.uom,
      l.unitPrice,
      l.lineNetValue,
      l.deliveryDate,
      l.plant,
    ]),
  );

  if (env.CSV_LAYOUT === 'header_lines_pair') {
    // Option B — separate header and lines files sharing the correlation ID.
    return {
      files: [
        {
          suffix: '_H.csv',
          content: [
            ...(env.CSV_HEADER_ROW ? [HEADER_COLUMNS.join(env.CSV_DELIMITER)] : []),
            row(headerCells),
            '',
          ].join('\n'),
        },
        {
          suffix: '_L.csv',
          content: [
            ...(env.CSV_HEADER_ROW ? [LINE_COLUMNS.join(env.CSV_DELIMITER)] : []),
            ...lineRows,
            '',
          ].join('\n'),
        },
      ],
    };
  }

  // Option A — one file, REC_TYPE marks header vs. line rows.
  //
  // No column-name row: H and L rows carry different columns, so any single header row
  // would describe at most one of them and mislead whoever wires up the SAP side. The
  // column meaning is fixed by REC_TYPE and documented in §8.2. Set CSV_HEADER_ROW=true
  // if the existing SAP job expects one anyway (IC-07, OQ-03).
  const rows = env.CSV_HEADER_ROW
    ? [HEADER_COLUMNS.join(env.CSV_DELIMITER), row(headerCells), ...lineRows]
    : [row(headerCells), ...lineRows];

  return {
    files: [{ suffix: '.csv', content: [...rows, ''].join('\n') }],
  };
}

/** FR-8.3 — the correlation ID is in the filename as well as the content. */
export const outboundBaseName = (correlationId: string, attempt: number) =>
  `PO_${correlationId}_${attempt}`;
