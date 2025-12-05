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

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: SMTP_SECURE === "true", // 465 -> true, 587 -> false
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  return transporter;
}

async function sendMail({ to, subject, html, text, cc, bcc, attachments }) {
  const t = getTransporter();

  // ✅ FORCE DISPLAY NAME
  const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER;
  const fromName =
    process.env.SMTP_FROM_NAME || "EduBridge ERP";

  const mailOptions = {
    from: `"${fromName}" <${fromEmail}>`, // 👈 FIXED HERE
    to,
    subject,
    html,
    text,
    cc,
    bcc,
    attachments,
  };

  const info = await t.sendMail(mailOptions);
  return info;
}

module.exports = {
  getTransporter,
  sendMail,
};
