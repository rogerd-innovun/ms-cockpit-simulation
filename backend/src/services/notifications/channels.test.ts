import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Nothing about the senders is mocked: nodemailer speaks real SMTP to a small server in this
// process, and fetch makes a real HTTP request to another. What these prove is that the bytes
// that leave the cockpit are what a mail server and a Teams webhook expect to receive.

vi.mock('../../db/client.js', () => ({ prisma: {} }));

const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM', 'PUBLIC_BASE_URL', 'NOTIFY_EMAIL_OVERRIDE_TO', 'NOTIFY_TEAMS_WEBHOOK_URL']) delete process.env[k];
});

/** Just enough SMTP to accept one message: no TLS, no auth. Collects what it was sent. */
function smtpStub() {
  const got = { from: '', to: [] as string[], data: '' };
  const server = net.createServer((sock) => {
    let inData = false;
    let buf = '';
    sock.write('220 stub ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (inData) {
        if (buf.endsWith('\r\n.\r\n')) {
          got.data = buf;
          inData = false;
          buf = '';
          sock.write('250 queued\r\n');
        }
        return;
      }
      for (const line of buf.split('\r\n').filter(Boolean)) {
        if (/^EHLO/i.test(line)) sock.write('250-stub\r\n250 8BITMIME\r\n');
        else if (/^MAIL FROM/i.test(line)) { got.from = line; sock.write('250 ok\r\n'); }
        else if (/^RCPT TO/i.test(line)) { got.to.push(line); sock.write('250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go ahead\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
      if (!inData) buf = '';
    });
  });
  servers.push({ close: () => server.close() });
  return new Promise<{ port: number; got: typeof got }>((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, got })));
}

function webhookStub(status = 202, body = '') {
  const got: { method?: string; contentType?: string; json?: unknown } = {};
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      got.method = req.method;
      got.contentType = req.headers['content-type'];
      got.json = JSON.parse(raw);
      res.writeHead(status).end(body);
    });
  });
  servers.push({ close: () => server.close() });
  return new Promise<{ url: string; got: typeof got }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/workflows/SECRET-TOKEN-123`, got })),
  );
}

async function load(settings: Record<string, string>) {
  Object.assign(process.env, settings);
  vi.resetModules();
  return import('./channels.js');
}

const message = { kind: 'REVIEW_NEEDED' as const, title: 'PO APX-1 is ready for review', body: 'Apex Fastener Supply Inc. 4 lines.', recordId: 'rec-1' };

describe('email over real SMTP', () => {
  it('delivers the message to the recipient with a subject, both text and HTML parts, and the link', async () => {
    const smtp = await smtpStub();
    const { sendEmail } = await load({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_FROM: 'PO Cockpit <cockpit@test.example>', PUBLIC_BASE_URL: 'https://po.example.com' });
    await sendEmail('approver@cockpit.local', message);

    expect(smtp.got.from).toContain('cockpit@test.example');
    expect(smtp.got.to).toEqual(['RCPT TO:<approver@cockpit.local>']);
    expect(smtp.got.data).toContain('Subject: [PO Cockpit] PO APX-1 is ready for review');
    expect(smtp.got.data).toContain('text/plain');
    expect(smtp.got.data).toContain('text/html');
    expect(smtp.got.data).toContain('https://po.example.com/records/rec-1');
  });

  it('redirects every message to one address when told to, and still says who it was for', async () => {
    const smtp = await smtpStub();
    const { sendEmail } = await load({
      SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_FROM: 'cockpit@test.example', NOTIFY_EMAIL_OVERRIDE_TO: 'demo@mycompany.example',
    });
    await sendEmail('approver@cockpit.local', message);
    expect(smtp.got.to).toEqual(['RCPT TO:<demo@mycompany.example>']);
    // A long header is folded across lines on the wire (RFC 5322); read it as a mail client would.
    expect(smtp.got.data.replace(/\r?\n[ \t]+/g, ' ')).toContain('(for approver@cockpit.local)');
  });

  it('fails with the connection error when the mail server is down, so the outbox can retry', async () => {
    const dead = await smtpStub();
    servers.pop()!.close(); // nothing listens on that port now
    const { sendEmail } = await load({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(dead.port), SMTP_FROM: 'cockpit@test.example' });
    await expect(sendEmail('a@b.test', message)).rejects.toThrow(/ECONNREFUSED|connect/i);
  });
});

describe('Teams over real HTTP', () => {
  it('posts an Adaptive Card message as JSON', async () => {
    const hook = await webhookStub(202);
    const { sendTeams } = await load({ NOTIFY_TEAMS_WEBHOOK_URL: hook.url, PUBLIC_BASE_URL: 'https://po.example.com' });
    await sendTeams(message);

    expect(hook.got.method).toBe('POST');
    expect(hook.got.contentType).toContain('application/json');
    expect(hook.got.json).toMatchObject({
      type: 'message',
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { type: 'AdaptiveCard' } }],
    });
    expect(JSON.stringify(hook.got.json)).toContain('https://po.example.com/records/rec-1');
  });

  it('treats any 2xx as delivered', async () => {
    const hook = await webhookStub(200);
    const { sendTeams } = await load({ NOTIFY_TEAMS_WEBHOOK_URL: hook.url });
    await expect(sendTeams(message)).resolves.toBeUndefined();
  });

  it('reports a rejection, and never repeats the webhook URL, which is a credential', async () => {
    const hook = await webhookStub(400, 'Bad payload');
    const { sendTeams } = await load({ NOTIFY_TEAMS_WEBHOOK_URL: hook.url });
    const err = await sendTeams(message).catch((e: Error) => e);
    expect((err as Error).message).toContain('400');
    expect((err as Error).message).toContain('Bad payload');
    expect((err as Error).message).not.toContain('SECRET-TOKEN-123');
  });

  it('reports an unreachable webhook without leaking its URL either', async () => {
    const hook = await webhookStub();
    const url = hook.url;
    servers.pop()!.close();
    const { sendTeams } = await load({ NOTIFY_TEAMS_WEBHOOK_URL: url });
    const err = await sendTeams(message).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/could not be reached/);
    expect((err as Error).message).not.toContain('SECRET-TOKEN-123');
  });
});

describe('what is configured', () => {
  it('email needs both a server and a sender; Teams needs the webhook', async () => {
    const off = await load({});
    expect(off.emailConfigured()).toBe(false);
    expect(off.teamsConfigured()).toBe(false);
    const half = await load({ SMTP_HOST: 'smtp.test' });
    expect(half.emailConfigured()).toBe(false);
    const on = await load({ SMTP_FROM: 'c@test', NOTIFY_TEAMS_WEBHOOK_URL: 'https://x' });
    expect(on.emailConfigured()).toBe(true);
    expect(on.teamsConfigured()).toBe(true);
  });
});
