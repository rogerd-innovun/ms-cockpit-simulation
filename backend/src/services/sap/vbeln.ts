/**
 * The cockpit's Sales Order number, as SAP's VBELN (CHAR10) expects it.
 *
 * SAP stores VBELN through the ALPHA conversion exit: a purely numeric value is
 * left-padded with zeros to the full ten characters ("12345" → "0000012345"), and
 * anything else is kept left-aligned as typed. An ABAP SELECT on VBELN matches the
 * padded form only, so sending "12345" to ZEE_API_LOG finds nothing rather than
 * failing loudly — which is why the padding happens here, once, and is tested.
 *
 * A value longer than ten characters is refused, never truncated: truncating a
 * document number is how you end up reading the log of a different Sales Order.
 */
export const VBELN_LENGTH = 10;

export class VbelnError extends Error {}

export function toVbeln(soNumber: string | null | undefined): string {
  const value = (soNumber ?? '').trim().toUpperCase();
  if (!value) throw new VbelnError('There is no Sales Order number to send as VBELN.');
  if (value.length > VBELN_LENGTH) {
    throw new VbelnError(
      `Sales Order number "${value}" is ${value.length} characters; VBELN is CHAR${VBELN_LENGTH}.`,
    );
  }
  if (!/^[A-Z0-9]+$/.test(value)) {
    throw new VbelnError(`Sales Order number "${value}" contains characters VBELN cannot hold.`);
  }
  return /^\d+$/.test(value) ? value.padStart(VBELN_LENGTH, '0') : value;
}
