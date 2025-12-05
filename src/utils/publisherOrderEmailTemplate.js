// src/utils/publisherOrderEmailTemplate.js

function buildPublisherOrderEmailHtml(order) {
  const publisherName = order?.publisher?.name || "Publisher";
  const session = order?.academic_session || "-";
  const orderNo = order?.order_no || order?.id;
  const orderDateRaw = order?.order_date || order?.createdAt || null;

  const orderDate = orderDateRaw
    ? new Date(orderDateRaw).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : new Date().toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });

  const items = order.items || [];

  const rows = items
    .map((item, idx) => {
      const bookTitle = item.book?.title || `Book #${item.book_id}`;
      const className = item.book?.class_name || "";
      const subject = item.book?.subject || "";
      const codeOrIsbn = item.book?.code || item.book?.isbn || "";

      const ordered = Number(item.total_order_qty) || 0; // ✅ main qty
      const received = Number(item.received_qty || 0) || 0;
      const pending = Math.max(ordered - received, 0);

      return `
        <tr>
          <td style="padding:6px;border:1px solid #e5e7eb;text-align:center;">
            ${idx + 1}
          </td>
          <td style="padding:6px;border:1px solid #e5e7eb;">
            ${bookTitle}
          </td>
          <td style="padding:6px;border:1px solid #e5e7eb;">
            ${className}
          </td>
          <td style="padding:6px;border:1px solid #e5e7eb;">
            ${subject}
          </td>
          <td style="padding:6px;border:1px solid #e5e7eb;">
            ${codeOrIsbn}
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

  const totalOrdered = items.reduce(
    (sum, i) => sum + (Number(i.total_order_qty) || 0),
    0
  );
  const totalReceived = items.reduce(
    (sum, i) => sum + (Number(i.received_qty || 0) || 0),
    0
  );
  const totalPending = Math.max(totalOrdered - totalReceived, 0);

  return `
    <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color:#0f172a; font-size:13px;">
      <p>Dear ${publisherName},</p>

      <p>
        Please find below the purchase order for the academic session
        <strong>${session}</strong>.
      </p>

      <p style="margin-top:4px;">
        <strong>PO No:</strong> ${orderNo}<br/>
        <strong>PO Date:</strong> ${orderDate}<br/>
        <strong>Status:</strong> ${order.status || "-"}
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
        <strong>EduBridge ERP – Book Distribution</strong><br/>
        info@edubridgeerp.in
      </p>
    </div>
  `;
}

module.exports = { buildPublisherOrderEmailHtml };
