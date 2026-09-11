// services/mailer.js
//
// The one place that talks to a mail server.
//
// Plain SMTP through nodemailer, configured from the environment. Every
// transactional provider speaks SMTP -- SendGrid, Amazon SES, Postmark,
// Mailgun, Brevo, Google Workspace -- so switching provider is a change to
// .env, not to code:
//
//   SMTP_HOST     smtp.sendgrid.net, email-smtp.<region>.amazonaws.com, ...
//   SMTP_PORT     587 (STARTTLS, the default) or 465 (implicit TLS)
//   SMTP_SECURE   "true" for port 465; inferred from the port when unset
//   SMTP_USER     the provider's SMTP username
//   SMTP_PASS     the provider's SMTP password / API key
//   MAIL_FROM     "SyncHub <no-reply@yourdomain.com>" -- must be a sender the
//                 provider has verified, or mail is rejected or spam-foldered
//
// With no SMTP_HOST, nothing is sent: send() says so and the email is recorded
// as skipped. That is what makes development work without a mail account --
// and why it is skipped rather than failed: retrying would not conjure a mail
// server into existence.
const nodemailer = require("nodemailer");

const DEFAULT_FROM = "SyncHub by Stellen Infotech <no-reply@stelleninfotech.com>";

// undefined = not built yet; null = built, and there is no SMTP configured.
let transport;

function buildTransport() {
  const host = String(process.env.SMTP_HOST || "").trim();

  if (!host) return null;

  const port = Number(process.env.SMTP_PORT) || 587;
  const secure =
    process.env.SMTP_SECURE !== undefined
      ? process.env.SMTP_SECURE === "true"
      : port === 465;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" }
      : undefined,
  });
}

function getTransport() {
  if (transport === undefined) transport = buildTransport();
  return transport;
}

/** Is there a mail server to send through? */
function isConfigured() {
  return Boolean(getTransport());
}

/**
 * Send one email.
 *
 * Resolves `{ sent: true }` or `{ skipped: true, reason }`, and THROWS when the
 * server refuses or cannot be reached -- that is the case the caller retries.
 */
async function send({ to, subject, html, text }) {
  const smtp = getTransport();

  if (!smtp) {
    return {
      skipped: true,
      reason: "No mail server is configured (SMTP_HOST is not set).",
    };
  }

  const info = await smtp.sendMail({
    from: process.env.MAIL_FROM || DEFAULT_FROM,
    to,
    subject,
    html,
    text,
  });

  return { sent: true, messageId: info.messageId };
}

/**
 * Swap the transport, for tests. Passing nothing rebuilds it from the
 * environment on the next send.
 */
function setTransportForTests(fake) {
  transport = fake === undefined ? undefined : fake;
}

module.exports = { send, isConfigured, setTransportForTests, DEFAULT_FROM };
