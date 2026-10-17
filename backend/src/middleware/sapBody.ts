import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';

const EXAMPLE = '{"correlationId":"PO-...","attempt":1,"status":"SUCCESS","soNumber":"4500387184"}';

/** The first few characters of what was sent, printable only, so the sender can recognise their own text. */
const preview = (raw: unknown): string =>
  String(raw ?? '')
    .slice(0, 24)
    .replace(/[^\x20-\x7e]/g, '?');

/**
 * Runs just after the JSON body parser, for SAP's routes only. A body that is not JSON (for example
 * `sales_orders=4500...` sent with a JSON content type) used to come back as the parser's bare
 * "Unexpected token 's'..." message. This says what is wrong and what a right body looks like.
 */
export function sapBodyErrors(err: unknown, _req: Request, _res: Response, next: NextFunction) {
  const e = err as { type?: unknown; body?: unknown };
  if (e && e.type === 'entity.parse.failed') {
    return next(
      new AppError(
        400,
        `The body is not valid JSON (it starts: "${preview(e.body)}"). Send one JSON object with Content-Type: application/json, for example ${EXAMPLE}. See docs/04-sap-api.md.`,
        'BODY_NOT_JSON',
      ),
    );
  }
  next(err);
}

/**
 * A body sent as something other than JSON (form fields, plain text) is skipped by the JSON parser, so
 * the route would only say that fields are missing. Say what is actually wrong. No body at all passes
 * through, so the route can name the missing fields.
 */
export function requireJsonBody(req: Request, _res: Response, next: NextFunction) {
  // A request with no content (Content-Length: 0) has no content type to judge.
  if (req.headers['content-length'] !== '0' && req.is('application/json') === false) {
    return next(
      new AppError(
        415,
        `The body must be JSON: set Content-Type to application/json and send one JSON object, for example ${EXAMPLE}. This request's Content-Type was "${String(req.headers['content-type'] ?? '').slice(0, 60)}".`,
        'UNSUPPORTED_MEDIA_TYPE',
      ),
    );
  }
  next();
}
