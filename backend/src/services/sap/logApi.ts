/**
 * Client for ZEE_API_LOG, the SAP team's API keyed by Sales Order number.
 *
 * Contract as given by the SAP team: table IT_SALEORDERS, one row per Sales Order,
 * field VBELN (CHAR10). Nothing else is confirmed yet — not the endpoint, the
 * transport, the auth or the response — so every one of those is configuration
 * (see env.ts) and the response is stored exactly as SAP returned it rather than
 * mapped onto a shape we would be guessing at.
 *
 * Two transports cover the ways a Z function module is normally exposed to a
 * non-SAP caller: a JSON REST handler (SICF), and the SOAP web service SOAMANAGER
 * generates from the function module. Native RFC would need the SAP NW RFC SDK on
 * the host and is deliberately not attempted.
 */
import { env } from '../../config/env.js';

export const LOG_API_NAME = 'ZEE_API_LOG';

/** Namespace of a function module exposed as a web service without name mapping. */
const RFC_NAMESPACE = 'urn:sap-com:document:sap:rfc:functions';

/** Keeps one oversized SAP answer from bloating the audit table. */
const MAX_STORED_RESPONSE_CHARS = 64 * 1024;

export interface LogApiConfig {
  mode: 'off' | 'mock' | 'live';
  url: string;
  format: 'json' | 'soap';
  user: string;
  password: string;
  sapClient: string;
  csrf: boolean;
  timeoutMs: number;
}

export const logApiConfig = (): LogApiConfig => ({
  mode: env.SAP_LOG_API_MODE,
  url: env.SAP_LOG_API_URL,
  format: env.SAP_LOG_API_FORMAT,
  user: env.SAP_LOG_API_USER,
  password: env.SAP_LOG_API_PASSWORD,
  sapClient: env.SAP_CLIENT,
  csrf: env.SAP_LOG_API_CSRF,
  timeoutMs: env.SAP_LOG_API_TIMEOUT_MS,
});

/** One call, as stored in the audit trail and shown on the record. Holds no credentials. */
export interface LogApiCall {
  api: typeof LOG_API_NAME;
  mode: 'mock' | 'live';
  format: 'json' | 'soap';
  endpoint: string | null;
  vbelns: string[];
  ok: boolean;
  httpStatus: number | null;
  durationMs: number;
  requestBody: string;
  /** Parsed when SAP answered JSON; otherwise the raw body text. */
  response: unknown;
  error: string | null;
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildLogApiRequest(
  vbelns: string[],
  format: LogApiConfig['format'],
): { body: string; headers: Record<string, string> } {
  if (format === 'soap') {
    const rows = vbelns.map((v) => `<item><VBELN>${xmlEscape(v)}</VBELN></item>`).join('');
    return {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        // SOAP 1.1 wants the header present; the SAP SOAP runtime routes on the body.
        SOAPAction: '""',
      },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="${RFC_NAMESPACE}">` +
        '<soapenv:Header/><soapenv:Body>' +
        `<urn:${LOG_API_NAME}><IT_SALEORDERS>${rows}</IT_SALEORDERS></urn:${LOG_API_NAME}>` +
        '</soapenv:Body></soapenv:Envelope>',
    };
  }
  return {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ IT_SALEORDERS: vbelns.map((VBELN) => ({ VBELN })) }),
  };
}

/**
 * The URL we actually call, with sap-client applied. fetch refuses a URL that carries
 * credentials, so any user:password@ in SAP_LOG_API_URL moves into basic auth instead —
 * which also keeps the password out of the endpoint stored with each call.
 */
export function resolveEndpoint(cfg: Pick<LogApiConfig, 'url' | 'sapClient' | 'user' | 'password'>) {
  const url = new URL(cfg.url);
  if (cfg.sapClient) url.searchParams.set('sap-client', cfg.sapClient);
  const user = cfg.user || decodeURIComponent(url.username);
  const password = cfg.user ? cfg.password : decodeURIComponent(url.password);
  url.username = '';
  url.password = '';
  return { url, user, password };
}

function readBody(text: string, contentType: string | null): unknown {
  const looksJson = contentType?.includes('json') || /^\s*[[{]/.test(text);
  if (looksJson) {
    try {
      return JSON.parse(text);
    } catch {
      /* fall through to raw text — SAP sometimes labels HTML error pages as JSON */
    }
  }
  return text.length > MAX_STORED_RESPONSE_CHARS
    ? `${text.slice(0, MAX_STORED_RESPONSE_CHARS)}\n… truncated (${text.length} characters)`
    : text;
}

/**
 * Gateway and many ICF services reject a modifying request without a token fetched
 * on the same session, so the session cookies go back with the POST.
 */
async function fetchCsrfToken(
  url: URL,
  auth: Record<string, string>,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  const res = await fetch(url, { method: 'GET', headers: { ...auth, 'X-CSRF-Token': 'Fetch' }, signal });
  const token = res.headers.get('x-csrf-token');
  if (!token || token.toLowerCase() === 'required') {
    throw new Error(`SAP returned no CSRF token (HTTP ${res.status}) — check the user and the endpoint.`);
  }
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return { 'X-CSRF-Token': token, ...(cookie ? { Cookie: cookie } : {}) };
}

export async function callLogApi(vbelns: string[], cfg: LogApiConfig = logApiConfig()): Promise<LogApiCall> {
  if (cfg.mode === 'off') throw new Error(`${LOG_API_NAME} is switched off (SAP_LOG_API_MODE=off).`);

  const request = buildLogApiRequest(vbelns, cfg.format);
  const started = Date.now();
  const base = {
    api: LOG_API_NAME,
    mode: cfg.mode,
    format: cfg.format,
    vbelns,
    requestBody: request.body,
  } as const;

  if (cfg.mode === 'mock') {
    return {
      ...base,
      endpoint: null,
      ok: true,
      httpStatus: 200,
      durationMs: Date.now() - started,
      response: {
        simulated: true,
        note: 'SAP_LOG_API_MODE=mock: answered inside the cockpit. No SAP system was called.',
        IT_SALEORDERS: vbelns.map((VBELN) => ({ VBELN })),
      },
      error: null,
    };
  }

  let target: ReturnType<typeof resolveEndpoint>;
  try {
    target = resolveEndpoint(cfg);
  } catch {
    return {
      ...base,
      endpoint: null,
      ok: false,
      httpStatus: null,
      durationMs: 0,
      response: null,
      error: `SAP_LOG_API_URL "${cfg.url}" is not a valid URL.`,
    };
  }

  const { url: endpoint, user, password } = target;
  const auth: Record<string, string> = user
    ? { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` }
    : {};
  const signal = AbortSignal.timeout(cfg.timeoutMs);

  try {
    const csrf = cfg.csrf ? await fetchCsrfToken(endpoint, auth, signal) : {};
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { ...request.headers, ...auth, ...csrf },
      body: request.body,
      signal,
    });
    const text = await res.text();
    return {
      ...base,
      endpoint: endpoint.toString(),
      ok: res.ok,
      httpStatus: res.status,
      durationMs: Date.now() - started,
      response: readBody(text, res.headers.get('content-type')),
      error: res.ok ? null : `SAP answered HTTP ${res.status} ${res.statusText}`.trim(),
    };
  } catch (err) {
    // fetch reports a network failure as "fetch failed" with the useful part (ECONNREFUSED,
    // ENOTFOUND, a TLS error) in `cause`.
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const error =
      e.name === 'TimeoutError'
        ? `No answer from SAP within ${Math.round(cfg.timeoutMs / 1000)} s.`
        : e.cause
          ? `Could not reach SAP: ${e.cause.code ?? e.cause.message}`
          : e.message;
    return {
      ...base,
      endpoint: endpoint.toString(),
      ok: false,
      httpStatus: null,
      durationMs: Date.now() - started,
      response: null,
      error,
    };
  }
}
