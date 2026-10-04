import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { emailMessage, teamsMessage, type Outgoing } from './messages.js';

/** Email needs a server and a sender; Teams needs its webhook. Nothing is sent over a channel that is not set up. */
export const emailConfigured = () => Boolean(env.SMTP_HOST && env.SMTP_FROM);
export const teamsConfigured = () => Boolean(env.NOTIFY_TEAMS_WEBHOOK_URL);

/** Which kinds go to the Teams channel: the configured list, or all of them when none is given. */
export function teamsWants(kind: string): boolean {
  const list = env.NOTIFY_TEAMS_KINDS.split(',').map((k) => k.trim()).filter(Boolean);
  return list.length === 0 || list.includes(kind);
}

let transporter: Transporter | null = null;

function transport(): Transporter {
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    // A mail server that hangs must not hold a delivery for minutes.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transporter;
}

export async function sendEmail(to: string, m: Outgoing): Promise<void> {
  const redirected = Boolean(env.NOTIFY_EMAIL_OVERRIDE_TO);
  const msg = emailMessage(m, env.PUBLIC_BASE_URL, redirected ? to : undefined);
  await transport().sendMail({ from: env.SMTP_FROM, to: redirected ? env.NOTIFY_EMAIL_OVERRIDE_TO : to, ...msg });
}

/**
 * Posts to the Teams webhook. The URL is a credential, so it appears in no message and no log:
 * an error says what went wrong, never where it was sent.
 */
export async function sendTeams(m: Outgoing, fetchImpl: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(env.NOTIFY_TEAMS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(teamsMessage(m, env.PUBLIC_BASE_URL)),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    throw new Error(`The Teams webhook could not be reached (${cause ?? (err as Error).name}).`);
  }
  // Workflows answers 202 Accepted; any 2xx means it took the message.
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`The Teams webhook answered ${res.status}${detail ? `: ${detail}` : ''}.`);
  }
}
