import express, { Router } from 'express';
import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { childLogger } from '../../lib/logger.js';
import { normaliseIp } from '../../middleware/sapApiAuth.js';

const log = childLogger('sap-capture');

const KEEP = 20; // the most recent captures held in memory (lost on restart; the log keeps the rest)
const STORED_CHARS = 20_000;
const LOGGED_CHARS = 8_000;
const PREVIEW_CHARS = 2_000;
const FIELD_PREVIEW_CHARS = 300;

export type BodyKind = 'empty' | 'json' | 'form' | 'xml' | 'delimited' | 'text' | 'binary';

type JsonInfo =
  | { valid: true; shape: 'object' | 'array' | 'other'; keys?: string[]; items?: number }
  | { valid: false; error: string };

interface TextInfo {
  kind: Exclude<BodyKind, 'empty' | 'binary' | 'form'>;
  json?: JsonInfo;
  delimiter?: string;
}

export interface BodyDescription {
  bytes: number;
  kind: BodyKind;
  /** The body as text; for a binary body, the first bytes in hex. */
  text: string;
  json?: JsonInfo;
  delimiter?: string;
  /** For `a=b&c=d` bodies: each field, with what its value looks like. */
  form?: Record<string, { chars: number; kind: TextInfo['kind']; preview: string }>;
}

const DELIMITERS: [string, string][] = [
  ['\t', 'tab'],
  [';', 'semicolon'],
  ['|', 'pipe'],
  [',', 'comma'],
];

/** What a piece of text looks like: JSON, XML, delimited rows (a table written as text), or just text. */
function classifyText(text: string, contentTypeSaysJson: boolean): TextInfo {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[') || contentTypeSaysJson) {
    try {
      const v: unknown = JSON.parse(t);
      const json: JsonInfo = Array.isArray(v)
        ? { valid: true, shape: 'array', items: v.length }
        : v && typeof v === 'object'
          ? { valid: true, shape: 'object', keys: Object.keys(v).slice(0, 40) }
          : { valid: true, shape: 'other' };
      return { kind: 'json', json };
    } catch (e) {
      const json: JsonInfo = { valid: false, error: (e as Error).message.slice(0, 200) };
      // Starts like JSON but is not: say so rather than guessing it is a table.
      return t.startsWith('{') || t.startsWith('[') ? { kind: 'text', json } : { ...classifyPlain(t), json };
    }
  }
  return classifyPlain(t);
}

function classifyPlain(t: string): TextInfo {
  if (t.startsWith('<')) return { kind: 'xml' };
  const lines = t.split(/\r?\n/).filter((l) => l.trim() !== '');
  for (const [d, name] of DELIMITERS) {
    if (lines.length > 1 ? lines[0]!.includes(d) && lines[1]!.includes(d) : d === '\t' && (lines[0]?.split(d).length ?? 0) > 2) {
      return { kind: 'delimited', delimiter: name };
    }
  }
  return { kind: 'text' };
}

/**
 * Works out what SAP actually sent. Pure, so it can be tested without a server. Never throws: whatever
 * arrives, binary or not, gets described.
 */
export function describeBody(buf: Buffer, contentType: string): BodyDescription {
  if (buf.length === 0) return { bytes: 0, kind: 'empty', text: '' };

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    if (text.includes('\u0000')) throw new Error('NUL');
  } catch {
    return { bytes: buf.length, kind: 'binary', text: buf.subarray(0, 200).toString('hex') };
  }

  const isForm =
    /x-www-form-urlencoded/i.test(contentType) || /^[A-Za-z_][\w.\-%]*=/.test(text.trim());
  if (isForm && !/^\s*[{[]/.test(text)) {
    const form: NonNullable<BodyDescription['form']> = {};
    for (const [name, value] of new URLSearchParams(text.trim())) {
      form[name] = { chars: value.length, kind: classifyText(value, false).kind, preview: value.slice(0, FIELD_PREVIEW_CHARS) };
    }
    return { bytes: buf.length, kind: 'form', text, form };
  }

  const c = classifyText(text, /json/i.test(contentType));
  return { bytes: buf.length, kind: c.kind, text, json: c.json, delimiter: c.delimiter };
}

const SHOWN_HEADERS = [
  'content-type',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'user-agent',
  'accept',
  'expect',
  'x-forwarded-for',
];

/** Only headers that help work out the format. Never the key (Authorization, X-API-Key) or cookies. */
const pickHeaders = (req: Request): Record<string, string> =>
  Object.fromEntries(
    SHOWN_HEADERS.flatMap((h) => {
      const v = req.headers[h];
      return v === undefined ? [] : [[h, String(v).slice(0, 200)]];
    }),
  );

interface Capture {
  at: string;
  ip: string;
  method: string;
  path: string;
  contentType: string;
  headers: Record<string, string>;
  bytes: number;
  kind: BodyKind;
  body: string;
  json?: JsonInfo;
  delimiter?: string;
  form?: BodyDescription['form'];
}

const captures: Capture[] = [];
export const resetCaptures = () => (captures.length = 0);

function record(req: Request, res: Response) {
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const contentType = String(req.headers['content-type'] ?? '');
  const d = describeBody(buf, contentType);
  const headers = pickHeaders(req);
  const ip = normaliseIp(req.ip);

  captures.unshift({
    at: new Date().toISOString(),
    ip,
    method: req.method,
    path: req.originalUrl.slice(0, 200),
    contentType: contentType.slice(0, 200),
    headers,
    bytes: d.bytes,
    kind: d.kind,
    body: d.text.slice(0, STORED_CHARS),
    json: d.json,
    delimiter: d.delimiter,
    form: d.form,
  });
  if (captures.length > KEEP) captures.length = KEEP;

  log.info(
    { ip, method: req.method, contentType, bytes: d.bytes, kind: d.kind, headers, body: d.text.slice(0, LOGGED_CHARS) },
    'SAP API capture',
  );

  res.json({
    received: true,
    note: 'Recorded as sent. Nothing was applied to any order.',
    bytes: d.bytes,
    contentType,
    kind: d.kind,
    delimiter: d.delimiter,
    json: d.json,
    form: d.form,
    headers,
    preview: d.text.slice(0, PREVIEW_CHARS),
  });
}

/**
 * A place for SAP to send a body in a format we do not know yet. It keeps the raw text instead of parsing
 * it, and says what it looks like, so the next step is a mapping written from a real example. It sits
 * behind the same key as the rest of the SAP API (the app checks that first) and changes no order.
 *
 *   POST|PUT /api/integration/sap/echo   record what arrived
 *   GET      /api/integration/sap/echo   the latest captures, newest first (this server's memory only)
 *
 * Mounted before the JSON parser, which would otherwise reject any body that is not JSON.
 */
export const sapCaptureRouter = Router();
sapCaptureRouter.use((_req, _res, next) => (env.SAP_API_CAPTURE ? next() : next('router')));
sapCaptureRouter.use(express.raw({ type: () => true, limit: '1mb' }));
sapCaptureRouter.post('/', record);
sapCaptureRouter.put('/', record);
sapCaptureRouter.get('/', (_req, res) => {
  res.json({ keep: KEEP, count: captures.length, captures });
});
