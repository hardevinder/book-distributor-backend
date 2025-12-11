// src/config/email.js
const nodemailer = require("nodemailer");

let transporter;

function getTransporter() {
  if (transporter) return transporter;

  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASS,
    SMTP_SECURE,
  } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error(
      "SMTP config missing. Please set SMTP_HOST, SMTP_USER, SMTP_PASS in .env"
    );
  }

  const port = Number(SMTP_PORT) || 587;
  const secure = SMTP_SECURE === "true"; // true for 465, false for 587 (usually)

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
    // If your provider has a proper certificate, you don't need this.
    // Only uncomment if you're getting CERT related errors.
    // tls: { rejectUnauthorized: false },
  });

  return transporter;
}

async function sendMail({ to, subject, html, text, cc, bcc, attachments }) {
  const t = getTransporter();

  const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER;
  const fromName = process.env.SMTP_FROM_NAME || "EduBridge ERP";

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
      subject,
      from: mailOptions.from,
    });

    const info = await t.sendMail(mailOptions);

    console.log("[MAIL] SMTP accepted email:", {
      messageId: info.messageId,
      response: info.response,
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
