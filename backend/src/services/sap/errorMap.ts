/**
 * FR-11.2 — SAP message codes are not written for the person who has to fix them.
 * This maps the codes we expect to plain language plus a remedy, and degrades to the
 * raw SAP text for anything unmapped rather than hiding it.
 *
 * The real code list is OQ-05; these are the common S/4HANA sales-order rejections.
 */
export interface MappedError {
  code: string;
  explanation: string;
  remedy: string;
  /** Field path to highlight in the review screen, where the code implies one. FR-11.3. */
  fieldHint?: 'header.customerCode' | 'header.currency' | 'lineItems' | 'header.poDate';
}

const MAP: Record<string, Omit<MappedError, 'code'>> = {
  MATERIAL_NOT_FOUND: {
    explanation: 'SAP does not recognise one of the material codes on this order.',
    remedy: 'Check the material code on the flagged line against the source PO, then resubmit.',
    fieldHint: 'lineItems',
  },
  CUSTOMER_NOT_FOUND: {
    explanation: 'SAP does not recognise the customer code on this order.',
    remedy: 'Verify the customer code against the PO and SAP master data, then resubmit.',
    fieldHint: 'header.customerCode',
  },
  CUSTOMER_BLOCKED: {
    explanation: 'The customer account is blocked for sales in SAP.',
    remedy: 'This needs a credit or master-data decision in SAP before the order can be created.',
    fieldHint: 'header.customerCode',
  },
  CREDIT_LIMIT_EXCEEDED: {
    explanation: "The order exceeds the customer's credit limit.",
    remedy: 'Route to credit control; resubmitting unchanged will fail again.',
  },
  INVALID_UOM: {
    explanation: 'A unit of measure on this order is not valid for that material in SAP.',
    remedy: 'Correct the UOM on the flagged line to the material’s SAP base or sales unit.',
    fieldHint: 'lineItems',
  },
  PRICING_ERROR: {
    explanation: 'SAP could not determine a price for one or more lines.',
    remedy: 'Check the unit price and currency; a missing condition record may need SAP attention.',
  },
  INVALID_CURRENCY: {
    explanation: 'The currency is not valid for this customer or sales area in SAP.',
    remedy: 'Confirm the currency on the PO and the customer’s sales-area settings.',
    fieldHint: 'header.currency',
  },
  DUPLICATE_PO: {
    explanation: 'SAP already holds a Sales Order for this customer PO number.',
    remedy: 'Check whether the order was already created before resubmitting.',
  },
  NO_RESPONSE_FROM_SAP: {
    explanation: 'The file was delivered to SAP but no result came back within the expected window.',
    remedy: 'Check that the SAP polling job is running before resubmitting — the order may already exist.',
  },
  OUTBOUND_WRITE_FAILED: {
    explanation: 'The cockpit could not write the order file to the SAP drop folder.',
    remedy: 'This is an infrastructure problem, not a data problem. Operations should check the folder, then approve again.',
  },
};

export function mapSapError(code: string | null, rawMessage: string | null): MappedError | null {
  if (!code && !rawMessage) return null;
  const known = code ? MAP[code.trim().toUpperCase()] : undefined;
  if (known) return { code: code!.trim().toUpperCase(), ...known };
  return {
    code: code ?? 'UNKNOWN',
    explanation: rawMessage ?? 'SAP rejected the order without a readable reason.',
    remedy: 'Review the raw SAP message below, correct the data if it points to a field, and resubmit.',
  };
}
