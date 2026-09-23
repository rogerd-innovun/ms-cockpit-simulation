import { z } from 'zod';

/**
 * The extraction contract. FR-5.2 / FR-5.3.
 *
 * Values are carried as strings end to end: the source document is the authority, and
 * coercing "1.000,50" to a number too early destroys evidence a reviewer needs. Numeric
 * checks happen in validation (FR-6.2) against the normalised form.
 */

export const HEADER_FIELDS = [
  'poNumber',
  'poDate',
  'customerName',
  'customerCode',
  'shipTo',
  'billTo',
  'requestedDeliveryDate',
  'currency',
  'paymentTerms',
  'incoterms',
  'poTotalValue',
  'contact',
] as const;

export type HeaderField = (typeof HEADER_FIELDS)[number];

export const LINE_FIELDS = [
  'materialCode',
  'customerMaterialNumber',
  'description',
  'quantity',
  'uom',
  'unitPrice',
  'lineNetValue',
  'deliveryDate',
  'plant',
] as const;

export type LineField = (typeof LINE_FIELDS)[number];

/** FR-6.2 — required for a submission to be well formed. */
export const REQUIRED_HEADER_FIELDS: readonly HeaderField[] = [
  'poNumber',
  'poDate',
  'customerCode',
  'currency',
];

export const REQUIRED_LINE_FIELDS: readonly LineField[] = ['materialCode', 'quantity', 'uom'];

export const HEADER_LABELS: Record<HeaderField, string> = {
  poNumber: 'PO Number',
  poDate: 'PO Date',
  customerName: 'Customer Name',
  customerCode: 'Customer Code',
  shipTo: 'Ship-To',
  billTo: 'Bill-To',
  requestedDeliveryDate: 'Requested Delivery Date',
  currency: 'Currency',
  paymentTerms: 'Payment Terms',
  incoterms: 'Incoterms',
  poTotalValue: 'PO Total Value',
  contact: 'Contact',
};

export const LINE_LABELS: Record<LineField, string> = {
  materialCode: 'Material Code',
  customerMaterialNumber: 'Customer Material No.',
  description: 'Description',
  quantity: 'Quantity',
  uom: 'UOM',
  unitPrice: 'Unit Price',
  lineNetValue: 'Line Net Value',
  deliveryDate: 'Delivery Date',
  plant: 'Plant',
};

/** A value plus the model's confidence in it. FR-4.8. */
const confidentValue = z.object({
  value: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
});

export type ConfidentValue = z.infer<typeof confidentValue>;

export const extractedHeaderSchema = z.object(
  Object.fromEntries(HEADER_FIELDS.map((f) => [f, confidentValue])) as Record<
    HeaderField,
    typeof confidentValue
  >,
);

export const extractedLineSchema = z
  .object({ lineNumber: z.number().int().positive() })
  .extend(
    Object.fromEntries(LINE_FIELDS.map((f) => [f, confidentValue])) as Record<
      LineField,
      typeof confidentValue
    >,
  );

/** FR-4.13 — a response that does not conform to this is a failed attempt, not reviewable data. */
export const extractionResultSchema = z.object({
  header: extractedHeaderSchema,
  lineItems: z.array(extractedLineSchema).min(1),
  vendorIdentified: z.string().nullable().optional(),
});

export type ExtractedHeader = z.infer<typeof extractedHeaderSchema>;
export type ExtractedLine = z.infer<typeof extractedLineSchema>;
export type ExtractionResult = z.infer<typeof extractionResultSchema>;

export const headerFieldPath = (f: HeaderField) => `header.${f}`;
export const lineFieldPath = (lineNumber: number, f: LineField) => `line.${lineNumber}.${f}`;
