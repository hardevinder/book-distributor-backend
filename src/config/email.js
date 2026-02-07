// src/config/email.js
const nodemailer = require("nodemailer");

let transporter;

/**
 * SMTP config:
 * - Gmail on VPS: port 465 works (SMTPS), port 587 may be blocked.
 * - Use SMTP_PORT=465 and SMTP_SECURE=true
 */
function getTransporter() {
  if (transporter) return transporter;

  const SMTP_HOST = String(process.env.SMTP_HOST || "").trim();
  const SMTP_PORT = Number(process.env.SMTP_PORT) || 465;
  const SMTP_USER = String(process.env.SMTP_USER || "").trim();
  const SMTP_PASS = String(process.env.SMTP_PASS || "").trim();

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error("SMTP config missing. Please set SMTP_HOST, SMTP_USER, SMTP_PASS in .env");
  }

  // ✅ For Gmail on VPS: prefer 465 SSL (secure)
  const secure =
    String(process.env.SMTP_SECURE || "").trim().toLowerCase() === "true" || SMTP_PORT === 465;

  console.log("[MAIL] Creating transporter:", {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure,
    user: SMTP_USER,
  });

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure, // ✅ true for 465
    auth: { user: SMTP_USER, pass: SMTP_PASS },

    // ✅ Timeouts (helpful for clear failure instead of hanging)
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS) || 20000,
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS) || 20000,
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS) || 30000,

    // ✅ Prefer IPv4 (some servers have flaky IPv6)
    dns: { family: 4 },

    // ✅ For SSL on 465, this is enough. Don’t force requireTLS here.
    tls: {
      servername: SMTP_HOST,
      // Do NOT set rejectUnauthorized:false for timeouts.
      // Only if you get CERT errors.
      // rejectUnauthorized: true,
    },
  });

  return transporter;
}

/** Optional: quick health check */
async function verifyTransporter() {
  try {
    const t = getTransporter();
    await t.verify();
    console.log("[MAIL] SMTP verify: OK");
    return true;
  } catch (err) {
    console.error("[MAIL] SMTP verify failed:", err);
    return false;
  }
}

async function sendMail({ to, subject, html, text, cc, bcc, attachments }) {
  const t = getTransporter();

  // ✅ Keep SMTP_FROM as email only. Name comes from SMTP_FROM_NAME.
  const fromEmail = String(process.env.SMTP_FROM || process.env.SMTP_USER || "").trim();
  const fromName = String(process.env.SMTP_FROM_NAME || "Sumeet Book Store").trim();

  if (!fromEmail) throw new Error("SMTP_FROM / SMTP_USER missing for 'from' address.");
  if (!to) throw new Error("'to' is required");

  const mailOptions = {
    from: `"${fromName}" <${fromEmail}>`,
    to,
    cc: cc || undefined,
    bcc: bcc || undefined,
    subject: subject || "(No subject)",
    html: html || undefined,
    text: text || undefined,
    attachments: attachments || undefined,
  };

  try {
    console.log("[MAIL] Sending email:", {
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE,
      from: mailOptions.from,
      to,
      cc: mailOptions.cc || "",
      subject: mailOptions.subject,
    });

    const info = await t.sendMail(mailOptions);

    console.log("[MAIL] SMTP accepted email:", {
      messageId: info.messageId,
      response: info.response,
      accepted: info.accepted,
      rejected: info.rejected,
    });

    return info;
  } catch (err) {
    console.error("[MAIL] SMTP error while sending email:", err);
    throw err;
  }
}

module.exports = {
  getTransporter,
  verifyTransporter,
  sendMail,
};
