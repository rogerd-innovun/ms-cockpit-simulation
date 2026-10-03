import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLogApiRequest, callLogApi, type LogApiConfig } from './logApi.js';

/** A stand-in SAP endpoint that records what it was sent. */
interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
let base = '';
const seen: Seen[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const path = new URL(req.url!, 'http://x').pathname;

      if (path === '/csrf') {
        if (req.method === 'GET' && req.headers['x-csrf-token'] === 'Fetch') {
          res.writeHead(200, { 'x-csrf-token': 'tok-123', 'set-cookie': 'SAP_SESSIONID=abc; path=/; HttpOnly' });
          return res.end();
        }
        if (req.headers['x-csrf-token'] !== 'tok-123' || !req.headers.cookie?.includes('SAP_SESSIONID=abc')) {
          res.writeHead(403, { 'x-csrf-token': 'Required' });
          return res.end('CSRF token validation failed');
        }
      }
      if (path === '/fault') {
        res.writeHead(500, { 'content-type': 'text/xml' });
        return res.end('<soap-env:Fault><faultstring>Function module ZEE_API_LOG not found</faultstring></soap-env:Fault>');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ET_LOG: [{ VBELN: '4500123456', MSG: 'ok' }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const cfg = (over: Partial<LogApiConfig> = {}): LogApiConfig => ({
  mode: 'live',
  url: `${base}/sap/bc/zee_api_log`,
  format: 'json',
  user: 'COCKPIT_RFC',
  password: 's3cret-pw',
  sapClient: '100',
  csrf: false,
  timeoutMs: 5000,
  ...over,
});

describe('ZEE_API_LOG request shape', () => {
  it('JSON: one IT_SALEORDERS row per Sales Order, field VBELN', () => {
    const { body } = buildLogApiRequest(['4500123456', '0000012345'], 'json');
    expect(JSON.parse(body)).toEqual({
      IT_SALEORDERS: [{ VBELN: '4500123456' }, { VBELN: '0000012345' }],
    });
  });

  it('SOAP: the function-module envelope with IT_SALEORDERS/item/VBELN', () => {
    const { body, headers } = buildLogApiRequest(['4500123456'], 'soap');
    expect(headers['Content-Type']).toMatch(/^text\/xml/);
    expect(body).toContain('xmlns:urn="urn:sap-com:document:sap:rfc:functions"');
    expect(body).toContain(
      '<urn:ZEE_API_LOG><IT_SALEORDERS><item><VBELN>4500123456</VBELN></item></IT_SALEORDERS></urn:ZEE_API_LOG>',
    );
  });
});

describe('callLogApi', () => {
  it('mock mode answers without touching the network', async () => {
    const before = seen.length;
    const call = await callLogApi(['4500123456'], cfg({ mode: 'mock', url: '' }));
    expect(call.ok).toBe(true);
    expect(call.response).toMatchObject({ simulated: true });
    expect(seen.length).toBe(before);
  });

  it('live: POSTs the payload with basic auth and sap-client, and keeps the parsed answer', async () => {
    const call = await callLogApi(['4500123456'], cfg());
    const req = seen.at(-1)!;

    expect(req.method).toBe('POST');
    expect(req.url).toBe('/sap/bc/zee_api_log?sap-client=100');
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from('COCKPIT_RFC:s3cret-pw').toString('base64')}`);
    expect(JSON.parse(req.body)).toEqual({ IT_SALEORDERS: [{ VBELN: '4500123456' }] });

    expect(call).toMatchObject({ ok: true, httpStatus: 200, error: null });
    expect(call.response).toEqual({ ET_LOG: [{ VBELN: '4500123456', MSG: 'ok' }] });
  });

  it('never carries the credentials into what gets stored', async () => {
    const call = await callLogApi(['4500123456'], cfg({ url: `http://u:urlpw@${base.slice(7)}/x` }));
    expect(call.ok).toBe(true);
    const stored = JSON.stringify(call);
    expect(stored).not.toContain('s3cret-pw');
    expect(stored).not.toContain('urlpw');
  });

  it('uses credentials written into the URL as basic auth when no user is configured', async () => {
    await callLogApi(['4500123456'], cfg({ url: `http://u:urlpw@${base.slice(7)}/x`, user: '', password: '' }));
    expect(seen.at(-1)!.headers.authorization).toBe(`Basic ${Buffer.from('u:urlpw').toString('base64')}`);
  });

  it('fetches a CSRF token first and sends it back with the session cookie', async () => {
    const call = await callLogApi(['4500123456'], cfg({ url: `${base}/csrf`, csrf: true }));
    expect(call).toMatchObject({ ok: true, httpStatus: 200 });
    const [fetchReq, postReq] = seen.slice(-2);
    expect(fetchReq!.method).toBe('GET');
    expect(postReq!.headers['x-csrf-token']).toBe('tok-123');
    expect(postReq!.headers.cookie).toBe('SAP_SESSIONID=abc');
  });

  it('shows a CSRF rejection as a failed call rather than throwing', async () => {
    const call = await callLogApi(['4500123456'], cfg({ url: `${base}/csrf`, csrf: false }));
    expect(call).toMatchObject({ ok: false, httpStatus: 403 });
    expect(call.response).toBe('CSRF token validation failed');
  });

  it('keeps a SOAP fault body as raw text', async () => {
    const call = await callLogApi(['4500123456'], cfg({ url: `${base}/fault`, format: 'soap' }));
    expect(call).toMatchObject({ ok: false, httpStatus: 500 });
    expect(call.response).toContain('ZEE_API_LOG not found');
  });

  it('reports an unreachable host as a failed call', async () => {
    const call = await callLogApi(['4500123456'], cfg({ url: 'http://127.0.0.1:1/x' }));
    expect(call.ok).toBe(false);
    expect(call.httpStatus).toBeNull();
    expect(call.error).toMatch(/Could not reach SAP/);
  });
});
