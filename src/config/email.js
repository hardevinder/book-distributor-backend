// src/config/email.js
const nodemailer = require("nodemailer");

let transporter;

function getTransporter() {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error(
      "SMTP config missing. Please set SMTP_HOST, SMTP_USER, SMTP_PASS in .env"
    );
  }

  const port = Number(SMTP_PORT) || 587;

  // ✅ Safe default:
  // - 465 => secure true
  // - 587 => secure false (STARTTLS)
  // If SMTP_SECURE is explicitly set, honor it.
  const secure =
    process.env.SMTP_SECURE != null
      ? process.env.SMTP_SECURE === "true"
      : port === 465;

  console.log("[MAIL] Creating transporter:", {
    host: SMTP_HOST,
    port,
    secure,
    user: SMTP_USER,
  });

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },

    // ✅ Prevent “hang / timeout” on server
    connectionTimeout: 20_000, // connect timeout
    greetingTimeout: 20_000, // server greeting timeout
    socketTimeout: 30_000, // idle socket timeout

    // ✅ Helpful for strict STARTTLS servers (587)
    requireTLS: !secure,
    tls: {
      servername: SMTP_HOST,
      // If your provider has a proper certificate, you don't need this.
      // Only uncomment if you're getting CERT related errors.
      // rejectUnauthorized: false,
    },
  });

  return transporter;
}

async function sendMail({ to, subject, html, text, cc, bcc, attachments }) {
  const t = getTransporter();

  const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER;
  const fromName = process.env.SMTP_FROM_NAME || "Sumeet Book Store";

  const mailOptions = {
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject,
    html,
    text,
    cc,
    bcc,
    attachments,
  };

  try {
    console.log("[MAIL] Sending email:", {
      to,
      cc,
      bcc,
      subject,
      from: mailOptions.from,
      attachments: Array.isArray(attachments) ? attachments.length : 0,
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
    // Re-throw so controller can send 500 instead of "success"
    throw err;
  }
}

module.exports = {
  getTransporter,
  sendMail,
};
