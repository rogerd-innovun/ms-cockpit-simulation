import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { childLogger } from '../lib/logger.js';

const log = childLogger('sap-api');

/** Express may report an IPv4 caller as "::ffff:103.44.1.206". */
export const normaliseIp = (ip: string | undefined): string => (ip ?? '').replace(/^::ffff:/i, '').trim();

const ipv4ToInt = (ip: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
};

/**
 * Is this address on the list? Entries are single addresses ("103.44.1.206") or IPv4 ranges
 * ("103.44.1.0/24"). An empty list allows everyone: the key is then the only protection.
 */
export function ipAllowed(ip: string, list: readonly string[]): boolean {
  if (list.length === 0) return true;
  const addr = normaliseIp(ip);
  const n = ipv4ToInt(addr);
  return list.some((entry) => {
    const [base, bits] = entry.trim().split('/');
    if (!base) return false;
    if (bits === undefined) return normaliseIp(base) === addr;
    const b = ipv4ToInt(base);
    const width = Number(bits);
    if (n === null || b === null || !Number.isInteger(width) || width < 0 || width > 32) return false;
    const mask = width === 0 ? 0 : (0xffffffff << (32 - width)) >>> 0;
    return (n & mask) === (b & mask);
  });
}

export const allowedIps = (): string[] =>
  env.SAP_API_ALLOWED_IPS.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * What the server actually saw, for the log line of a turned-away call: the address it settled on,
 * the socket's own peer, the raw X-Forwarded-For chain and how many proxies are trusted. When an
 * allow-list rejects SAP, this is what shows whether the proxy count is wrong. None of it is secret.
 */
export function callerTrace(req: Pick<Request, 'ip' | 'headers' | 'socket'>) {
  const forwarded = req.headers['x-forwarded-for'];
  return {
    ip: normaliseIp(req.ip),
    socket: normaliseIp(req.socket?.remoteAddress),
    forwardedFor: (Array.isArray(forwarded) ? forwarded.join(', ') : forwarded ?? '').slice(0, 200),
    trustProxy: env.TRUST_PROXY,
  };
}

/**
 * The key, from "Authorization: Bearer <key>", "X-API-Key: <key>", or an ordinary HTTP Basic
 * login whose password is the key (what ABAP's HTTP client does natively). Basic also has to
 * carry the configured user name, so a login with the wrong name fails like a wrong key.
 */
export function presentedKey(req: Pick<Request, 'headers'>): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  if (typeof auth === 'string' && /^Basic\s+/i.test(auth)) {
    const decoded = Buffer.from(auth.replace(/^Basic\s+/i, '').trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return decoded.slice(0, colon) === env.SAP_API_USER ? decoded.slice(colon + 1) : null;
  }
  const header = req.headers['x-api-key'];
  return typeof header === 'string' && header.trim() ? header.trim() : null;
}

/** Compares in constant time, so the response time does not tell a caller how much of a guess was right. */
export function keyMatches(presented: string | null, expected: string): boolean {
  if (!presented || !expected) return false;
  const h = (s: string) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(presented), h(expected));
}

// Ten wrong keys from one address in ten minutes and it is turned away for the rest of the window.
const WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 10;
const failures = new Map<string, { n: number; since: number }>();

export const resetSapApiFailures = () => failures.clear();

/**
 * Guards everything under /api/integration/sap. The SAP system is not a person, so it does not
 * sign in: it presents a long shared key (SAP_API_KEY), and, if SAP_API_ALLOWED_IPS is set,
 * must also be calling from a listed address. The address check comes first, so an address
 * that is not listed learns nothing about whether its key was right.
 */
export function sapApiAuth(req: Request, res: Response, next: NextFunction) {
  // The app checks this before it reads the body (so a stranger sending junk is told "unauthorised",
  // not "bad JSON"), and the router checks it again; the second look must not count twice.
  if (res.locals.sapApiAuthed) return next();
  if (!env.SAP_API_KEY) {
    return next(new AppError(503, 'The SAP API is not switched on. Set SAP_API_KEY on the server.', 'SAP_API_DISABLED'));
  }
  const ip = normaliseIp(req.ip);

  if (!ipAllowed(ip, allowedIps())) {
    log.warn(callerTrace(req), 'SAP API call from an address that is not allowed');
    return next(new AppError(403, 'This address is not allowed to use the SAP API.', 'IP_NOT_ALLOWED'));
  }

  const now = Date.now();
  const seen = failures.get(ip);
  if (seen && now - seen.since < WINDOW_MS && seen.n >= MAX_FAILURES) {
    return next(new AppError(429, 'Too many wrong keys from this address. Try again in a few minutes.', 'TOO_MANY_ATTEMPTS'));
  }

  if (!keyMatches(presentedKey(req), env.SAP_API_KEY)) {
    const fresh = !seen || now - seen.since >= WINDOW_MS;
    failures.set(ip, { n: fresh ? 1 : seen.n + 1, since: fresh ? now : seen.since });
    log.warn(callerTrace(req), 'SAP API call with a missing or wrong key');
    // A 401 that asks for Basic login is what makes an HTTP client offer its credentials.
    res.setHeader('WWW-Authenticate', 'Basic realm="PO Cockpit SAP API", charset="UTF-8"');
    return next(
      new AppError(
        401,
        'Missing or wrong credentials. Send the key as "Authorization: Bearer <key>", as "X-API-Key: <key>", or as an HTTP Basic login (user "' +
          env.SAP_API_USER +
          '", the key as the password).',
        'UNAUTHORIZED',
      ),
    );
  }
  failures.delete(ip);
  res.locals.sapApiAuthed = true;
  next();
}
