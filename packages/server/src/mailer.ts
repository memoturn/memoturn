import { createTransport, type Transporter } from "nodemailer";

/**
 * Transactional email adapter with two interchangeable transports behind one `sendEmail`:
 *
 *   - **smtp**   — any SMTP server via nodemailer (SMTP_HOST/PORT/USER/PASS/SECURE).
 *   - **resend** — Resend's HTTP API (RESEND_API_KEY), no SMTP server needed.
 *
 * The transport is picked from config: an explicit `EMAIL_TRANSPORT`, else Resend if a
 * RESEND_API_KEY is set, else SMTP if `SMTP_CONNECTION_URL` or `SMTP_HOST` is set, else
 * disabled. `sendEmail` never throws and returns false when unconfigured — so an email
 * alert channel is best-effort, exactly like the webhook/Slack channels.
 *
 * SMTP accepts either a single `SMTP_CONNECTION_URL` (`smtp://`, `smtps://`, and nodemailer's
 * `ses://<region>` all work) or the discrete `SMTP_HOST/PORT/USER/PASS/SECURE` vars. The
 * connection URL wins when both are set.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type MailerKind = "resend" | "smtp" | "none";

const DEFAULT_FROM = "memoturn <alerts@memoturn.local>";

function resolveFrom(): string {
  return process.env.EMAIL_FROM ?? process.env.ALERT_EMAIL_FROM ?? DEFAULT_FROM;
}

/** Which transport is active, given the current env. */
function selectedKind(): MailerKind {
  const explicit = (process.env.EMAIL_TRANSPORT ?? "").toLowerCase();
  if (explicit === "resend" || explicit === "smtp") return explicit;
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.SMTP_CONNECTION_URL || process.env.SMTP_HOST) return "smtp";
  return "none";
}

/** Whether email is configured, and which transport would be used (for ops/health surfaces). */
export function mailerStatus(): { configured: boolean; transport: MailerKind } {
  const transport = selectedKind();
  return { configured: transport !== "none", transport };
}

// SMTP transporter is created lazily and cached (one pooled connection for the process).
let smtp: Transporter | undefined;
function smtpTransport(): Transporter {
  if (!smtp) {
    const url = process.env.SMTP_CONNECTION_URL;
    if (url) {
      // Single connection string — nodemailer parses smtp:// / smtps:// / ses://<region>.
      smtp = createTransport(url);
    } else {
      const port = Number(process.env.SMTP_PORT ?? 587);
      smtp = createTransport({
        host: process.env.SMTP_HOST,
        port,
        // Implicit TLS on 465; STARTTLS on 587/others. Override with SMTP_SECURE=true.
        secure: (process.env.SMTP_SECURE ?? "").toLowerCase() === "true" || port === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      });
    }
  }
  return smtp;
}

async function sendViaResend(msg: EmailMessage, from: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function sendViaSmtp(msg: EmailMessage, from: string): Promise<void> {
  await smtpTransport().sendMail({ from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
}

/**
 * Send an email via the configured transport. Never throws; returns false if email is
 * unconfigured (`none`) or the send failed (logged as structured JSON).
 */
export async function sendEmail(msg: EmailMessage): Promise<boolean> {
  const kind = selectedKind();
  if (kind === "none") return false;
  const from = resolveFrom();
  try {
    if (kind === "resend") await sendViaResend(msg, from);
    else await sendViaSmtp(msg, from);
    return true;
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        scope: "mailer.send",
        transport: kind,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
}
