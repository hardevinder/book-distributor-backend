// src/utils/publisherOrderEmailTemplate.js

"use strict";

/**
 * Publisher Order Email Template (HTML)
 * ✅ Removes hard-coded "EduBridge ERP" branding
 * ✅ Supports branding via:
 *    1) companyProfile (preferred)  -> { name, email, phone_primary, address_line1, address_line2, city, state, pincode, gstin }
 *    2) env fallback                -> MAIL_FROM_NAME / ORDER_SUPPORT_EMAIL / SMTP_FROM / SMTP_USER
 * ✅ Safe HTML escaping for dynamic text
 * ✅ Keeps your table + totals same
 */

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function fmtDateIN(d) {
  const raw = d ? new Date(d) : null;
  const dt = raw && !Number.isNaN(raw.getTime()) ? raw : new Date();
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function buildCompanyFooter(companyProfile) {
  const name =
    companyProfile?.name ||
    process.env.MAIL_FROM_NAME ||
    "Sumeet Book Store";

  const email =
    companyProfile?.email ||
    process.env.ORDER_SUPPORT_EMAIL ||
    process.env.SMTP_FROM ||
    process.env.SMTP_USER ||
    "";

  const phone = companyProfile?.phone_primary || companyProfile?.phone || "";
  const gstin = companyProfile?.gstin || "";

  const addr = [
    companyProfile?.address_line1,
    companyProfile?.address_line2,
    [companyProfile?.city, companyProfile?.state, companyProfile?.pincode].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join(", ");

  const lines = [
    `<strong>${escapeHtml(name)}</strong>`,
    addr ? escapeHtml(addr) : "",
    phone ? `Phone: ${escapeHtml(phone)}` : "",
    email ? `Email: ${escapeHtml(email)}` : "",
    gstin ? `GSTIN: ${escapeHtml(gstin)}` : "",
  ].filter(Boolean);

  return lines.join("<br/>");
}

// ✅ UPDATED signature: accept companyProfile optionally
function buildPublisherOrderEmailHtml(order, companyProfile = null) {
  const publisherName = order?.publisher?.name || "Publisher";
  const session = order?.academic_session || "-";
  const orderNo = order?.order_no || order?.id;
  const orderDate = fmtDateIN(order?.order_date || order?.createdAt || null);

  const items = Array.isArray(order?.items) ? order.items : [];

  const rows = items
    .map((item, idx) => {
      const bookTitle = item?.book?.title || `Book #${item?.book_id}`;
      const className = item?.book?.class_name || "";
      const subject = item?.book?.subject || "";
      const codeOrIsbn = item?.book?.code || item?.book?.isbn || "";

      const ordered = Number(item?.total_order_qty) || 0;
      const received = Number(item?.received_qty) || 0;
      const pending = Math.max(ordered - received, 0);

      return `
        <tr>
          <td style="padding:6px;border:1px solid #e5e7eb;text-align:center;">
            ${idx + 1}
          </td>
          <td style="padding:6px;border:1px solid #e5e7eb;">
            ${escapeHtml(bookTitle)}
          </td>
          <td style="padding:6px;border:1px solid #e5e7eb;">
            ${escapeHtml(className)}
          </td>
          <td style="padding:6px;border:1px solid #e5e7eb;">
            ${escapeHtml(subject)}
          </td>
          <td style="padding:6px;border:1px solid #e5e7eb;">
            ${escapeHtml(codeOrIsbn)}
          </td>
          <td style="padding:6px;border:1px solid #e5e7eb;text-align:right;">
            ${ordered}
          </td>
          <td style="padding:6px;border:1px solid #e5e7eb;text-align:right;">
            ${received}
          </td>
          <td style="padding:6px;border:1px solid #e5e7eb;text-align:right;">
            ${pending}
          </td>
        </tr>
      `;
    })
    .join("");

  const totalOrdered = items.reduce((sum, i) => sum + (Number(i?.total_order_qty) || 0), 0);
  const totalReceived = items.reduce((sum, i) => sum + (Number(i?.received_qty) || 0), 0);
  const totalPending = Math.max(totalOrdered - totalReceived, 0);

  const footerHtml = buildCompanyFooter(companyProfile);

  return `
    <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color:#0f172a; font-size:13px;">
      <p>Dear ${escapeHtml(publisherName)},</p>

      <p>
        Please find below the purchase order for the academic session
        <strong>${escapeHtml(session)}</strong>.
      </p>

      <p style="margin-top:4px;">
        <strong>PO No:</strong> ${escapeHtml(orderNo)}<br/>
        <strong>PO Date:</strong> ${escapeHtml(orderDate)}<br/>
        <strong>Status:</strong> ${escapeHtml(order?.status || "-")}
      </p>

      <table cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-top:10px; width:100%; max-width:800px;">
        <thead>
          <tr style="background:#f3f4f6;">
            <th style="padding:6px;border:1px solid #e5e7eb;">S.No</th>
            <th style="padding:6px;border:1px solid #e5e7eb;">Book Title</th>
            <th style="padding:6px;border:1px solid #e5e7eb;">Class</th>
            <th style="padding:6px;border:1px solid #e5e7eb;">Subject</th>
            <th style="padding:6px;border:1px solid #e5e7eb;">Code / ISBN</th>
            <th style="padding:6px;border:1px solid #e5e7eb;text-align:right;">Ordered</th>
            <th style="padding:6px;border:1px solid #e5e7eb;text-align:right;">Received</th>
            <th style="padding:6px;border:1px solid #e5e7eb;text-align:right;">Pending</th>
          </tr>
        </thead>
        <tbody>
          ${
            rows ||
            `<tr>
              <td colspan="8" style="padding:6px;border:1px solid #e5e7eb;text-align:center;color:#6b7280;">
                No items found in this order.
              </td>
            </tr>`
          }
          <tr style="background:#f9fafb;">
            <td colspan="5" style="padding:6px;border:1px solid #e5e7eb;text-align:right;">
              <strong>Total</strong>
            </td>
            <td style="padding:6px;border:1px solid #e5e7eb;text-align:right;">
              <strong>${totalOrdered}</strong>
            </td>
            <td style="padding:6px;border:1px solid #e5e7eb;text-align:right;">
              <strong>${totalReceived}</strong>
            </td>
            <td style="padding:6px;border:1px solid #e5e7eb;text-align:right;">
              <strong>${totalPending}</strong>
            </td>
          </tr>
        </tbody>
      </table>

      <p style="margin-top:16px;">
        Kindly confirm the availability, expected dispatch date and applicable discounts, if any.
      </p>

      <p style="margin-top:16px;">
        Regards,<br/>
        ${footerHtml}
      </p>
    </div>
  `;
}

module.exports = { buildPublisherOrderEmailHtml };
