import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The SAP system is not a person, so it gets in with a shared key and, optionally, from listed
// addresses. These tests are about who is let in and who is not, through a real Express app.

vi.mock('../db/client.js', () => ({ prisma: {} }));

const KEY = 'k'.repeat(10) + 'sap-test-key-0123456789';
const ENV = ['SAP_API_KEY', 'SAP_API_ALLOWED_IPS', 'TRUST_PROXY', 'SAP_API_USER'];

async function load(settings: Record<string, string>) {
  Object.assign(process.env, settings);
  vi.resetModules();
  const mod = await import('./sapApiAuth.js');
  const { errorHandler } = await import('./error.js');
  const app = express();
  if (Number(settings.TRUST_PROXY ?? 0) > 0) app.set('trust proxy', Number(settings.TRUST_PROXY));
  app.get('/probe', mod.sapApiAuth, (req, res) => res.json({ ok: true, ip: req.ip }));
  app.use(errorHandler);
  return { app, ...mod };
}

afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

describe('addresses', () => {
  let ipAllowed: (ip: string, list: string[]) => boolean;
  beforeEach(async () => ({ ipAllowed } = await load({})));

  it('an empty list lets everyone in, because the key is then the only guard', () => {
    expect(ipAllowed('8.8.8.8', [])).toBe(true);
  });

  it('matches a single address, including one that Express reports in IPv6 form', () => {
    expect(ipAllowed('103.44.1.206', ['103.44.1.206'])).toBe(true);
    expect(ipAllowed('::ffff:103.44.1.206', ['103.44.1.206'])).toBe(true);
    expect(ipAllowed('103.44.1.207', ['103.44.1.206'])).toBe(false);
  });

  it('matches an IPv4 range', () => {
    expect(ipAllowed('103.44.1.250', ['103.44.1.0/24'])).toBe(true);
    expect(ipAllowed('103.44.2.1', ['103.44.1.0/24'])).toBe(false);
    expect(ipAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
  });

  it('does not let a malformed entry match everything', () => {
    expect(ipAllowed('8.8.8.8', ['not-an-ip'])).toBe(false);
    expect(ipAllowed('8.8.8.8', ['8.8.8.0/99'])).toBe(false);
    expect(ipAllowed('8.8.8.8', ['/24'])).toBe(false);
  });
});

describe('the key', () => {
  it('is switched off, and says so, until a key is configured', async () => {
    const { app } = await load({});
    const res = await request(app).get('/probe').set('X-API-Key', KEY);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SAP_API_DISABLED');
  });

  it('lets in the right key sent as a Bearer token or as X-API-Key', async () => {
    const { app } = await load({ SAP_API_KEY: KEY });
    expect((await request(app).get('/probe').set('Authorization', `Bearer ${KEY}`)).status).toBe(200);
    expect((await request(app).get('/probe').set('X-API-Key', KEY)).status).toBe(200);
  });

  it('turns away a missing or wrong key with 401 and no hint of the right one', async () => {
    const { app } = await load({ SAP_API_KEY: KEY });
    for (const set of [(r: request.Test) => r, (r: request.Test) => r.set('X-API-Key', 'wrong'), (r: request.Test) => r.set('Authorization', 'Bearer ' + KEY.slice(0, -1))]) {
      const res = await set(request(app).get('/probe'));
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(JSON.stringify(res.body)).not.toContain(KEY);
    }
  });

  it('stops answering an address that keeps guessing', async () => {
    const { app, resetSapApiFailures } = await load({ SAP_API_KEY: KEY });
    resetSapApiFailures();
    for (let i = 0; i < 10; i++) await request(app).get('/probe').set('X-API-Key', 'guess-' + i);
    const locked = await request(app).get('/probe').set('X-API-Key', KEY);
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    resetSapApiFailures();
  });

  it('a right key clears the count of wrong ones', async () => {
    const { app, resetSapApiFailures } = await load({ SAP_API_KEY: KEY });
    resetSapApiFailures();
    for (let i = 0; i < 9; i++) await request(app).get('/probe').set('X-API-Key', 'guess-' + i);
    expect((await request(app).get('/probe').set('X-API-Key', KEY)).status).toBe(200);
    for (let i = 0; i < 9; i++) await request(app).get('/probe').set('X-API-Key', 'guess-' + i);
    expect((await request(app).get('/probe').set('X-API-Key', KEY)).status).toBe(200);
    resetSapApiFailures();
  });
});

describe('the address list', () => {
  it('turns away an address that is not listed, even with the right key, before looking at the key', async () => {
    const { app } = await load({ SAP_API_KEY: KEY, SAP_API_ALLOWED_IPS: '103.44.1.206' });
    // supertest calls from loopback, which is not on the list
    const res = await request(app).get('/probe').set('X-API-Key', KEY);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('IP_NOT_ALLOWED');
    const noKey = await request(app).get('/probe');
    expect(noKey.status).toBe(403); // an unlisted address learns nothing about the key
  });

  it('lets in a listed address, read from X-Forwarded-For when a proxy is trusted', async () => {
    const { app } = await load({ SAP_API_KEY: KEY, SAP_API_ALLOWED_IPS: '103.44.1.206', TRUST_PROXY: '1' });
    const ok = await request(app).get('/probe').set('X-API-Key', KEY).set('X-Forwarded-For', '103.44.1.206');
    expect(ok.status).toBe(200);
    expect(ok.body.ip).toBe('103.44.1.206');
    const other = await request(app).get('/probe').set('X-API-Key', KEY).set('X-Forwarded-For', '203.0.113.9');
    expect(other.status).toBe(403);
  });

  it('ignores X-Forwarded-For when no proxy is trusted, so the list cannot be talked round', async () => {
    const { app } = await load({ SAP_API_KEY: KEY, SAP_API_ALLOWED_IPS: '103.44.1.206' });
    const res = await request(app).get('/probe').set('X-API-Key', KEY).set('X-Forwarded-For', '103.44.1.206');
    expect(res.status).toBe(403);
  });
});

describe('the trace of a turned-away call', () => {
  it('reports the address used, the socket peer, the forwarded chain and the proxy count', async () => {
    const { callerTrace } = await load({ TRUST_PROXY: '2' });
    const trace = callerTrace({
      ip: '::ffff:47.11.17.223',
      socket: { remoteAddress: '::ffff:10.24.6.28' },
      headers: { 'x-forwarded-for': '47.11.17.223, 172.70.1.2' },
    } as never);
    expect(trace).toEqual({ ip: '47.11.17.223', socket: '10.24.6.28', forwardedFor: '47.11.17.223, 172.70.1.2', trustProxy: 2 });
  });

  it('copes with no forwarded header and cuts a very long one', async () => {
    const { callerTrace } = await load({});
    const bare = callerTrace({ ip: '10.0.0.1', socket: {}, headers: {} } as never);
    expect(bare).toMatchObject({ ip: '10.0.0.1', socket: '', forwardedFor: '' });
    const long = callerTrace({ ip: '10.0.0.1', socket: {}, headers: { 'x-forwarded-for': 'a'.repeat(500) } } as never);
    expect(long.forwardedFor).toHaveLength(200);
  });
});

const basic = (user: string, pass: string) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

describe('HTTP Basic login (what ABAP offers natively)', () => {
  it('lets in the configured user name with the key as the password', async () => {
    const { app } = await load({ SAP_API_KEY: KEY });
    expect((await request(app).get('/probe').set('Authorization', basic('sap', KEY))).status).toBe(200);
  });

  it('uses the user name from SAP_API_USER when one is set', async () => {
    const { app } = await load({ SAP_API_KEY: KEY, SAP_API_USER: 'bods02' });
    expect((await request(app).get('/probe').set('Authorization', basic('bods02', KEY))).status).toBe(200);
    expect((await request(app).get('/probe').set('Authorization', basic('sap', KEY))).status).toBe(401);
    delete process.env.SAP_API_USER;
  });

  it('turns away a wrong password, a wrong name, and a login with no colon', async () => {
    const { app, resetSapApiFailures } = await load({ SAP_API_KEY: KEY });
    resetSapApiFailures();
    for (const header of [basic('sap', 'wrong'), basic('someone', KEY), 'Basic ' + Buffer.from('nocolon').toString('base64')]) {
      expect((await request(app).get('/probe').set('Authorization', header)).status).toBe(401);
    }
    resetSapApiFailures();
  });

  it('a 401 asks for a Basic login, which is what makes an HTTP client offer its credentials', async () => {
    const { app } = await load({ SAP_API_KEY: KEY });
    const res = await request(app).get('/probe');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Basic realm=/);
    expect(res.body.error.message).toContain('"sap"');
  });
});

describe('the whole app: the key is checked before the body is read', () => {
  async function fullApp() {
    process.env.SAP_API_KEY = KEY;
    vi.resetModules();
    const { createApp } = await import('../app.js');
    return createApp();
  }

  it('a stranger sending text that is not JSON is told "unauthorised", not "bad JSON"', async () => {
    const app = await fullApp();
    const res = await request(app).post('/api/integration/sap/results').set('Content-Type', 'application/json').send('sales_orders=4500123456');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('SAP with the right key and a body that is not JSON gets the real parse error', async () => {
    const app = await fullApp();
    const res = await request(app)
      .post('/api/integration/sap/results')
      .set('Authorization', basic('sap', KEY))
      .set('Content-Type', 'application/json')
      .send('sales_orders=4500123456');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BODY_NOT_JSON');
    // names what arrived and what a right body looks like, instead of the parser's bare "Unexpected token"
    expect(res.body.error.message).toContain('sales_orders=4500');
    expect(res.body.error.message).toContain('"correlationId"');
  });

  it('a body sent as form fields is told to use JSON, not just that fields are missing', async () => {
    const app = await fullApp();
    const res = await request(app)
      .post('/api/integration/sap/results')
      .set('Authorization', basic('sap', KEY))
      .type('form')
      .send({ sales_orders: '4500123456' });
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(res.body.error.message).toContain('application/json');
  });

  it('an empty body still reaches the route, which names the missing fields', async () => {
    const app = await fullApp();
    const res = await request(app).post('/api/integration/sap/results').set('Authorization', basic('sap', KEY));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('a wrong key costs one failed attempt, not two', async () => {
    const app = await fullApp();
    const { resetSapApiFailures: reset } = await import('./sapApiAuth.js');
    reset();
    for (let i = 0; i < 9; i++) await request(app).post('/api/integration/sap/results').send({});
    // nine failures so far; if each had counted twice the address would already be locked out
    expect((await request(app).get('/api/integration/sap/ping').set('X-API-Key', KEY)).status).toBe(200);
    reset();
  });
});
