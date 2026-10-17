import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The capture door exists for one reason: SAP sends a body we do not understand yet, and we need to see
// it exactly as sent. These tests are about that: any body is kept raw, the key is needed, the key is
// never recorded, and nothing is applied to an order.

vi.mock('../../db/client.js', () => ({ prisma: {} }));

const KEY = 'sap-capture-test-key-0123456789abcdef';
const basic = 'Basic ' + Buffer.from(`sap:${KEY}`).toString('base64');
const ENV = ['SAP_API_KEY', 'SAP_API_CAPTURE'];

async function load(settings: Record<string, string> = {}) {
  Object.assign(process.env, { SAP_API_KEY: KEY, ...settings });
  vi.resetModules();
  const { createApp } = await import('../../app.js');
  const capture = await import('./capture.js');
  capture.resetCaptures();
  return { app: createApp(), ...capture };
}

afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

describe('describeBody: what did SAP send?', () => {
  it('recognises the form-style body that started this: sales_orders=...', async () => {
    const { describeBody } = await load();
    const d = describeBody(Buffer.from('sales_orders=4500123456'), 'application/json');
    expect(d.kind).toBe('form');
    expect(d.form?.sales_orders).toMatchObject({ chars: 10, preview: '4500123456' });
  });

  it('looks inside a form field, so sales_orders=<rows> says what the rows are', async () => {
    const { describeBody } = await load();
    const rows = 'VBELN;BSTNK\n4500000001;PO-1\n4500000002;PO-2';
    const d = describeBody(Buffer.from('sales_orders=' + encodeURIComponent(rows)), 'application/x-www-form-urlencoded');
    expect(d.kind).toBe('form');
    expect(d.form?.sales_orders?.kind).toBe('delimited');
    expect(d.form?.sales_orders?.preview).toBe(rows);
  });

  it('recognises JSON and lists its top-level keys or item count', async () => {
    const { describeBody } = await load();
    expect(describeBody(Buffer.from('{"sales_orders":[{"VBELN":"1"}],"count":1}'), 'application/json')).toMatchObject({
      kind: 'json',
      json: { valid: true, shape: 'object', keys: ['sales_orders', 'count'] },
    });
    expect(describeBody(Buffer.from('[{"a":1},{"a":2}]'), '').json).toMatchObject({ valid: true, shape: 'array', items: 2 });
  });

  it('says a body that starts like JSON but is not JSON is text, with the parser error', async () => {
    const { describeBody } = await load();
    const d = describeBody(Buffer.from('{"a":1,}'), 'application/json');
    expect(d.kind).toBe('text');
    expect(d.json).toMatchObject({ valid: false });
  });

  it('recognises a table written as delimited text, and which delimiter', async () => {
    const { describeBody } = await load();
    expect(describeBody(Buffer.from('VBELN\tBSTNK\n4500000001\tPO-1\n'), 'text/plain')).toMatchObject({ kind: 'delimited', delimiter: 'tab' });
    expect(describeBody(Buffer.from('VBELN|BSTNK\n4500000001|PO-1'), 'text/plain')).toMatchObject({ kind: 'delimited', delimiter: 'pipe' });
  });

  it('recognises XML, empty and binary bodies without throwing', async () => {
    const { describeBody } = await load();
    expect(describeBody(Buffer.from('<?xml version="1.0"?><SALES_ORDERS/>'), 'text/xml').kind).toBe('xml');
    expect(describeBody(Buffer.alloc(0), '').kind).toBe('empty');
    const bin = describeBody(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe]), 'application/octet-stream');
    expect(bin.kind).toBe('binary');
    expect(bin.text).toBe('1f8b0800fffe');
  });
});

describe('POST /api/integration/sap/echo', () => {
  it('needs the key, however odd the body', async () => {
    const { app } = await load();
    const res = await request(app).post('/api/integration/sap/echo').set('Content-Type', 'application/json').send('sales_orders=4500123456');
    expect(res.status).toBe(401);
  });

  it('keeps a non-JSON body that claims to be JSON, which the real endpoints refuse', async () => {
    const { app } = await load();
    const res = await request(app)
      .post('/api/integration/sap/echo')
      .set('Authorization', basic)
      .set('Content-Type', 'application/json')
      .send('sales_orders=4500123456');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, bytes: 23, kind: 'form', preview: 'sales_orders=4500123456' });
    expect(res.body.note).toContain('Nothing was applied');
  });

  it('records the capture for a later look, newest first, and never the key', async () => {
    const { app } = await load();
    await request(app).post('/api/integration/sap/echo').set('X-API-Key', KEY).set('Content-Type', 'text/plain').send('first');
    await request(app).post('/api/integration/sap/echo').set('Authorization', basic).set('Content-Type', 'text/plain').send('second');

    const list = await request(app).get('/api/integration/sap/echo').set('X-API-Key', KEY);
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(2);
    expect(list.body.captures.map((c: { body: string }) => c.body)).toEqual(['second', 'first']);
    expect(list.body.captures[0].headers['content-type']).toBe('text/plain');

    const everything = JSON.stringify(list.body);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(basic.slice(6));
    expect(Object.keys(list.body.captures[0].headers)).not.toEqual(expect.arrayContaining(['authorization']));
  });

  it('listing the captures needs the key too', async () => {
    const { app } = await load();
    expect((await request(app).get('/api/integration/sap/echo')).status).toBe(401);
  });

  it('holds only the latest 20', async () => {
    const { app } = await load();
    for (let i = 0; i < 23; i++) {
      await request(app).post('/api/integration/sap/echo').set('X-API-Key', KEY).set('Content-Type', 'text/plain').send(`n${i}`);
    }
    const list = await request(app).get('/api/integration/sap/echo').set('X-API-Key', KEY);
    expect(list.body.count).toBe(20);
    expect(list.body.captures[0].body).toBe('n22');
    expect(list.body.captures[19].body).toBe('n3');
  });

  it('handles an empty POST and a body that is binary', async () => {
    const { app } = await load();
    const empty = await request(app).post('/api/integration/sap/echo').set('X-API-Key', KEY);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ bytes: 0, kind: 'empty' });

    const bin = await request(app)
      .post('/api/integration/sap/echo')
      .set('X-API-Key', KEY)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from([0x1f, 0x8b, 0x00, 0xff]));
    expect(bin.status).toBe(200);
    expect(bin.body).toMatchObject({ kind: 'binary', preview: '1f8b00ff' });
  });

  it('turns a body over the limit away with 413 instead of keeping it', async () => {
    const { app } = await load();
    const res = await request(app)
      .post('/api/integration/sap/echo')
      .set('X-API-Key', KEY)
      .set('Content-Type', 'text/plain')
      .send('x'.repeat(1024 * 1024 + 10));
    expect(res.status).toBe(413);
  });

  it('is switched off by SAP_API_CAPTURE=false', async () => {
    const { app } = await load({ SAP_API_CAPTURE: 'false' });
    const res = await request(app).post('/api/integration/sap/echo').set('X-API-Key', KEY).set('Content-Type', 'text/plain').send('hello');
    expect(res.status).toBe(404);
  });

  it('does not disturb the real endpoints: results still insists on JSON', async () => {
    const { app } = await load();
    const res = await request(app)
      .post('/api/integration/sap/results')
      .set('Authorization', basic)
      .set('Content-Type', 'application/json')
      .send('sales_orders=4500123456');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BODY_NOT_JSON');
  });
});
