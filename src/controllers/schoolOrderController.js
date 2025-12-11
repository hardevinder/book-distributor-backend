// src/controllers/schoolOrderController.js

const {
  SchoolBookRequirement,
  Book,
  School,
  SchoolOrder,
  SchoolOrderItem,
  SchoolRequirementOrderLink,
  Publisher,
  CompanyProfile,
  Transport, // ✅ include Transport model
  sequelize,
} = require("../models");

const { sendMail } = require("../config/email");
const { Op } = require("sequelize");
const PDFDocument = require("pdfkit"); // ✅ only pdfkit

function generateOrderNo(schoolId, academicSession) {
  const ts = Date.now();
  const sessionPart = academicSession
    ? academicSession.replace(/[^0-9]/g, "")
    : "NA";
  return `SO-${schoolId}-${sessionPart}-${ts}`;
}

/* ============================================
 * Helper: recompute order status from items
 * ============================================ */
async function recomputeOrderStatus(order, t) {
  const fresh = await SchoolOrder.findOne({
    where: { id: order.id },
    include: [
      {
        model: SchoolOrderItem,
        as: "items",
      },
    ],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

  const items = fresh.items || [];

  if (!items.length) {
    fresh.status = "draft";
    await fresh.save({ transaction: t });
    return fresh;
  }

  const totalOrdered = items.reduce(
    (sum, it) => sum + (Number(it.total_order_qty) || 0),
    0
  );
  const totalReceived = items.reduce(
    (sum, it) => sum + (Number(it.received_qty) || 0),
    0
  );

  if (fresh.status === "cancelled") {
    return fresh;
  }

  if (totalReceived === 0) {
    fresh.status = fresh.status === "draft" ? "draft" : "sent";
  } else if (totalReceived < totalOrdered) {
    fresh.status = "partial_received";
  } else if (totalReceived === totalOrdered) {
    fresh.status = "completed";
  }

  await fresh.save({ transaction: t });
  return fresh;
}

/* ============================================
 * GET /api/school-orders
 * ============================================ */
exports.listSchoolOrders = async (request, reply) => {
  try {
    const { academic_session, school_id, status } = request.query || {};

    const where = {};
    if (academic_session) where.academic_session = academic_session;
    if (school_id) where.school_id = school_id;
    if (status) where.status = status;

    const orders = await SchoolOrder.findAll({
      where,
      include: [
        { model: School, as: "school" },
        {
          model: SchoolOrderItem,
          as: "items",
          include: [
            {
              model: Book,
              as: "book",
              include: [
                {
                  model: Publisher,
                  as: "publisher",
                  attributes: ["id", "name"],
                },
              ],
            },
          ],
        },
        {
          model: Transport,
          as: "transport",
        },
      ],
      order: [
        [{ model: School, as: "school" }, "name", "ASC"],
        ["order_date", "DESC"],
        ["createdAt", "DESC"],
      ],
    });

    const plainOrders = orders.map((order) => {
      const o = order.toJSON();
      o.items =
        (o.items || []).map((it) => ({
          ...it,
          pending_qty:
            (Number(it.total_order_qty) || 0) - (Number(it.received_qty) || 0),
        })) || [];
      return o;
    });

    return reply.code(200).send(plainOrders);
  } catch (err) {
    request.log.error({ err }, "❌ Error in listSchoolOrders");
    return reply.code(500).send({
      error: "Error",
      message: err.message || "Failed to load school orders.",
    });
  }
};

/* ============================================
 * POST /api/school-orders/generate
 * ============================================ */
exports.generateOrdersForSession = async (request, reply) => {
  const { academic_session } = request.body || {};

  if (!academic_session || !academic_session.trim()) {
    return reply.code(400).send({
      error: "ValidationError",
      message: "academic_session is required.",
    });
  }

  const session = academic_session.trim();
  const t = await sequelize.transaction();

  try {
    const requirements = await SchoolBookRequirement.findAll({
      where: {
        academic_session: session,
        status: "confirmed",
      },
      include: [
        {
          model: Book,
          as: "book",
        },
        {
          model: School,
          as: "school",
        },
      ],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!requirements.length) {
      await t.rollback();
      return reply.code(200).send({
        message: "No confirmed requirements found for this session.",
        academic_session: session,
        orders_count: 0,
        orders: [],
      });
    }

    const mapBySchool = new Map();

    for (const reqRow of requirements) {
      const schoolId = reqRow.school_id;
      const book = reqRow.book;
      if (!schoolId || !book) continue;

      const qty = Number(reqRow.required_copies || 0);
      if (!qty || qty <= 0) continue;

      const bookId = book.id;

      if (!mapBySchool.has(schoolId)) {
        mapBySchool.set(schoolId, {
          books: new Map(),
        });
      }

      const schoolBucket = mapBySchool.get(schoolId);

      if (!schoolBucket.books.has(bookId)) {
        schoolBucket.books.set(bookId, {
          totalQty: 0,
          requirementRows: [],
        });
      }

      const bookBucket = schoolBucket.books.get(bookId);
      bookBucket.totalQty += qty;
      bookBucket.requirementRows.push(reqRow);
    }

    if (!mapBySchool.size) {
      await t.rollback();
      return reply.code(200).send({
        message:
          "No positive quantity found to generate school orders for this session.",
        academic_session: session,
        orders_count: 0,
        orders: [],
      });
    }

    const createdOrders = [];

    for (const [schoolId, data] of mapBySchool.entries()) {
      const orderNo = generateOrderNo(schoolId, session);

      const order = await SchoolOrder.create(
        {
          school_id: schoolId,
          order_no: orderNo,
          academic_session: session,
          order_date: new Date(),
          status: "draft",
        },
        { transaction: t }
      );

      const linksToCreate = [];
      const requirementIdsToUpdate = new Set();

      for (const [bookId, bookData] of data.books.entries()) {
        const totalQty = Number(bookData.totalQty || 0);
        if (!totalQty || totalQty <= 0) continue;

        const item = await SchoolOrderItem.create(
          {
            school_order_id: order.id,
            book_id: bookId,
            total_order_qty: totalQty,
            received_qty: 0,
            unit_price: null,
            total_amount: null,
          },
          { transaction: t }
        );

        for (const reqRow of bookData.requirementRows) {
          const rqQty = Number(reqRow.required_copies || 0);
          if (!rqQty || rqQty <= 0) continue;

          linksToCreate.push({
            requirement_id: reqRow.id,
            school_order_item_id: item.id,
            allocated_qty: rqQty,
          });
          requirementIdsToUpdate.add(reqRow.id);
        }
      }

      if (linksToCreate.length) {
        await SchoolRequirementOrderLink.bulkCreate(linksToCreate, {
          transaction: t,
        });
      }

      if (requirementIdsToUpdate.size > 0) {
        await SchoolBookRequirement.update(
          {
            status: "confirmed", // later can be "ordered"
          },
          {
            where: { id: Array.from(requirementIdsToUpdate) },
            transaction: t,
          }
        );
      }

      createdOrders.push(order);
    }

    await t.commit();

    return reply.code(201).send({
      message: "School orders generated successfully.",
      academic_session: session,
      orders_count: createdOrders.length,
      orders: createdOrders,
    });
  } catch (err) {
    try {
      if (!t.finished) await t.rollback();
    } catch (rollbackErr) {
      console.error("Rollback error in generateOrdersForSession:", rollbackErr);
    }

    console.error("Error in generateOrdersForSession:", err);
    return reply.code(500).send({
      error: "Error",
      message: err.message || "Failed to generate school orders.",
    });
  }
};

/* ============================================
 * PATCH /api/school-orders/:orderId/meta
 * After generating order → edit transport + notes
 * ============================================ */
exports.updateSchoolOrderMeta = async (request, reply) => {
  const { orderId } = request.params;
  const {
    transport_id,
    transport_through,
    notes,
    remarks, // optionally allow updating remarks as well
  } = request.body || {};

  try {
    const order = await SchoolOrder.findOne({
      where: { id: orderId },
    });

    if (!order) {
      return reply.code(404).send({ message: "School order not found." });
    }

    // ✅ transport_id (number or null)
    if (typeof transport_id !== "undefined") {
      const tidNum =
        transport_id === null || transport_id === ""
          ? null
          : Number(transport_id);
      order.transport_id = Number.isNaN(tidNum) ? null : tidNum;
    }

    // ✅ transport_through
    if (typeof transport_through !== "undefined") {
      order.transport_through =
        transport_through === null || transport_through === ""
          ? null
          : String(transport_through).trim();
    }

    // ✅ notes
    if (typeof notes !== "undefined") {
      order.notes =
        notes === null || notes === "" ? null : String(notes).trim();
    }

    // ✅ remarks (optional)
    if (typeof remarks !== "undefined") {
      order.remarks =
        remarks === null || remarks === "" ? null : String(remarks).trim();
    }

    await order.save();

    const updated = await SchoolOrder.findOne({
      where: { id: orderId },
      include: [
        { model: School, as: "school" },
        {
          model: SchoolOrderItem,
          as: "items",
          include: [
            {
              model: Book,
              as: "book",
              include: [
                {
                  model: Publisher,
                  as: "publisher",
                  attributes: ["id", "name"],
                },
              ],
            },
          ],
        },
        {
          model: Transport,
          as: "transport",
        },
      ],
    });

    const plain = updated.toJSON();
    plain.items =
      (plain.items || []).map((it) => ({
        ...it,
        pending_qty:
          (Number(it.total_order_qty) || 0) - (Number(it.received_qty) || 0),
      })) || [];

    return reply.code(200).send({
      message: "Order meta updated successfully.",
      order: plain,
    });
  } catch (err) {
    console.error("Error in updateSchoolOrderMeta:", err);
    return reply.code(500).send({
      error: "Error",
      message: err.message || "Failed to update order meta.",
    });
  }
};

/* ============================================
 * POST /api/school-orders/:orderId/receive
 * ============================================ */
exports.receiveOrderItems = async (request, reply) => {
  const { orderId } = request.params;
  const { items, status = "auto" } = request.body || {};

  if (!items || !Array.isArray(items) || !items.length) {
    return reply.code(400).send({
      error: "ValidationError",
      message: "items array is required.",
    });
  }

  const t = await sequelize.transaction();

  try {
    const order = await SchoolOrder.findOne({
      where: { id: orderId },
      include: [{ model: SchoolOrderItem, as: "items" }],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!order) {
      await t.rollback();
      return reply.code(404).send({ message: "School order not found." });
    }

    const itemById = new Map();
    for (const it of order.items || []) {
      itemById.set(it.id, it);
    }

    for (const row of items) {
      const itemId = row.item_id;
      let receivedQty = Number(row.received_qty ?? 0);

      if (!itemId || isNaN(receivedQty) || receivedQty < 0) continue;

      const item = itemById.get(itemId);
      if (!item) continue;

      const ordered = Number(item.total_order_qty) || 0;

      if (receivedQty > ordered) receivedQty = ordered;

      item.received_qty = receivedQty;
      await item.save({ transaction: t });
    }

    if (status === "cancelled") {
      order.status = "cancelled";
      await order.save({ transaction: t });
    } else {
      await recomputeOrderStatus(order, t);
    }

    const updated = await SchoolOrder.findOne({
      where: { id: orderId },
      include: [
        { model: School, as: "school" },
        {
          model: SchoolOrderItem,
          as: "items",
          include: [
            {
              model: Book,
              as: "book",
              include: [
                {
                  model: Publisher,
                  as: "publisher",
                  attributes: ["id", "name"],
                },
              ],
            },
          ],
        },
        {
          model: Transport,
          as: "transport",
        },
      ],
      transaction: t,
    });

    await t.commit();

    const plain = updated.toJSON();
    plain.items =
      (plain.items || []).map((it) => ({
        ...it,
        pending_qty:
          (Number(it.total_order_qty) || 0) - (Number(it.received_qty) || 0),
      })) || [];

    return reply.code(200).send({
      message: "Order items updated successfully.",
      order: plain,
    });
  } catch (err) {
    try {
      if (!t.finished) await t.rollback();
    } catch (rollbackErr) {
      console.error("Rollback error in receiveOrderItems:", rollbackErr);
    }

    console.error("Error in receiveOrderItems:", err);
    return reply.code(500).send({
      error: "Error",
      message: err.message || "Failed to update order items.",
    });
  }
};

/* ============================================
 * POST /api/school-orders/:orderId/reorder-pending
 * ============================================ */
exports.reorderPendingForOrder = async (request, reply) => {
  const { orderId } = request.params;
  const t = await sequelize.transaction();

  try {
    const sourceOrder = await SchoolOrder.findOne({
      where: { id: orderId },
      include: [
        { model: School, as: "school" },
        { model: SchoolOrderItem, as: "items" },
      ],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!sourceOrder) {
      await t.rollback();
      return reply.code(404).send({ message: "School order not found." });
    }

    const pendingItems = [];
    for (const it of sourceOrder.items || []) {
      const ordered = Number(it.total_order_qty) || 0;
      const received = Number(it.received_qty || 0);
      const pending = ordered - received;

      if (pending > 0) {
        pendingItems.push({
          book_id: it.book_id,
          pending_qty: pending,
        });
      }
    }

    if (!pendingItems.length) {
      await t.rollback();
      return reply.code(400).send({
        message: "No pending quantity found to re-order for this order.",
      });
    }

    const schoolId = sourceOrder.school_id;
    const session = sourceOrder.academic_session || null;

    const newOrderNo = generateOrderNo(schoolId, session || "NA");

    const newOrder = await SchoolOrder.create(
      {
        school_id: schoolId,
        order_no: newOrderNo,
        academic_session: session,
        order_date: new Date(),
        status: "draft",
        remarks: `Re-order for pending quantity of ${sourceOrder.order_no}`,
      },
      { transaction: t }
    );

    for (const row of pendingItems) {
      await SchoolOrderItem.create(
        {
          school_order_id: newOrder.id,
          book_id: row.book_id,
          total_order_qty: row.pending_qty,
          received_qty: 0,
          unit_price: null,
          total_amount: null,
        },
        { transaction: t }
      );
    }

    const fullNewOrder = await SchoolOrder.findOne({
      where: { id: newOrder.id },
      include: [
        { model: School, as: "school" },
        {
          model: SchoolOrderItem,
          as: "items",
          include: [
            {
              model: Book,
              as: "book",
              include: [
                {
                  model: Publisher,
                  as: "publisher",
                  attributes: ["id", "name"],
                },
              ],
            },
          ],
        },
        {
          model: Transport,
          as: "transport",
        },
      ],
      transaction: t,
    });

    await t.commit();

    return reply.code(201).send({
      message: "Re-order created successfully for pending quantity.",
      original_order_id: sourceOrder.id,
      new_order: fullNewOrder,
    });
  } catch (err) {
    try {
      if (!t.finished) await t.rollback();
    } catch (rollbackErr) {
      console.error("Rollback error in reorderPendingForOrder:", rollbackErr);
    }

    console.error("Error in reorderPendingForOrder:", err);
    return reply.code(500).send({
      error: "Error",
      message:
        err.message || "Failed to create re-order for pending quantity.",
    });
  }
};

/* ============================================
 * POST /api/school-orders/:orderId/send-email
 * - If ?publisher_id=xx → send to that publisher (publisher-wise) with PDF
 * - Else → send to school with full order PDF
 * ============================================ */
exports.sendOrderEmailForOrder = async (request, reply) => {
  const { orderId } = request.params;
  const { publisher_id } = request.query || {};

  try {
    const order = await SchoolOrder.findOne({
      where: { id: orderId },
      include: [
        { model: School, as: "school" },
        {
          model: SchoolOrderItem,
          as: "items",
          include: [
            {
              model: Book,
              as: "book",
              attributes: [
                "id",
                "title",
                "class_name",
                "subject",
                "code",
                "isbn",
                "publisher_id",
              ],
              include: [
                {
                  model: Publisher,
                  as: "publisher",
                  attributes: ["id", "name"],
                },
              ],
            },
          ],
        },
        {
          model: Transport,
          as: "transport",
        },
      ],
    });

    if (!order) {
      return reply.code(404).send({ message: "School order not found." });
    }

    const school = order.school;
    const items = order.items || [];

    const today = new Date();
    const todayStr = today.toLocaleDateString("en-IN");
    const orderDate = order.order_date
      ? new Date(order.order_date).toLocaleDateString("en-IN")
      : "-";

    // Company header for PDF
    const companyProfile = await CompanyProfile.findOne({
      where: { is_active: true },
      order: [
        ["is_default", "DESC"],
        ["id", "ASC"],
      ],
    });

    // Common: safe base for file name
    const safeOrderNo = String(
      order.order_no || `order-${order.id}`
    ).replace(/[^\w\-]+/g, "_");

    // Common support email for replyTo / display
    const supportEmail =
      process.env.ORDER_SUPPORT_EMAIL ||
      process.env.SMTP_FROM ||
      process.env.SMTP_USER;

    /* =======================================================
     * 1) PUBLISHER-WISE EMAIL (when ?publisher_id= present)
     * ======================================================= */
    if (publisher_id) {
      const pid = Number(publisher_id);
      if (Number.isNaN(pid)) {
        return reply.code(400).send({ message: "Invalid publisher_id." });
      }

      // Filter items for this publisher
      const itemsForPublisher = items.filter((it) => {
        const b = it.book;
        if (!b) return false;
        const pbid =
          (b.publisher && b.publisher.id) ||
          (b.publisher_id != null ? Number(b.publisher_id) : undefined);
        return pbid === pid;
      });

      if (!itemsForPublisher.length) {
        return reply.code(400).send({
          message:
            "No items found for this publisher in this school order.",
        });
      }

      // Fetch publisher from DB to get email fields
      let publisher = await Publisher.findByPk(pid);
      if (!publisher) {
        // fallback to whatever is on the item
        publisher = itemsForPublisher[0].book.publisher;
      }

      if (!publisher) {
        return reply
          .code(404)
          .send({ message: "Publisher not found for this order." });
      }

      // Decide which email to use from Publisher model
      const toEmail =
        publisher.email ||
        publisher.contact_email ||
        process.env.PUBLISHER_ORDER_FALLBACK_EMAIL;

      if (!toEmail) {
        return reply.code(400).send({
          message:
            "Publisher email not set. Please update publisher master or set PUBLISHER_ORDER_FALLBACK_EMAIL.",
        });
      }

      const subject = `Purchase Order ${order.order_no || order.id} – ${
        publisher.name
      }`;

      // Build HTML table for this publisher only
      const rowsHtml = itemsForPublisher
        .map((it, idx) => {
          const b = it.book || {};
          const ordered = Number(it.total_order_qty) || 0;
          const received = Number(it.received_qty) || 0;
          const pending = Math.max(ordered - received, 0);
          return `
            <tr>
              <td style="border:1px solid #ddd;padding:4px;">${idx + 1}</td>
              <td style="border:1px solid #ddd;padding:4px;">${b.title || ""}</td>
              <td style="border:1px solid #ddd;padding:4px;">${b.class_name || ""}</td>
              <td style="border:1px solid #ddd;padding:4px;">${b.subject || ""}</td>
              <td style="border:1px solid #ddd;padding:4px;">${
                b.code || b.isbn || ""
              }</td>
              <td style="border:1px solid #ddd;padding:4px;text-align:right;">${ordered}</td>
              <td style="border:1px solid #ddd;padding:4px;text-align:right;">${received}</td>
              <td style="border:1px solid #ddd;padding:4px;text-align:right;">${pending}</td>
            </tr>
          `;
        })
        .join("");

      const html = `
        <p>Dear ${publisher.name},</p>
        <p>
          Please find below the book order from
          <strong>${school?.name || "our client school"}</strong>
          for session <strong>${order.academic_session || "-"}</strong>.
        </p>

        <h3>Order Summary</h3>
        <div><strong>Order No:</strong> ${order.order_no || order.id}</div>
        <div><strong>School:</strong> ${
          school?.name || "-"
        }${school?.city ? " (" + school.city + ")" : ""}</div>
        <div><strong>School Email:</strong> ${school?.email || "-"}</div>
        <div><strong>Order Date:</strong> ${orderDate}</div>
        <div><strong>Print Date:</strong> ${todayStr}</div>
        <div><strong>Reply To (Query Email):</strong> ${supportEmail || "-"}</div>

        <h3 style="margin-top:16px;">Items for ${publisher.name}</h3>
        <table style="border-collapse:collapse;font-size:12px;">
          <thead>
            <tr>
              <th style="border:1px solid #ddd;padding:4px;">Sr</th>
              <th style="border:1px solid #ddd;padding:4px;">Book</th>
              <th style="border:1px solid #ddd;padding:4px;">Class</th>
              <th style="border:1px solid #ddd;padding:4px;">Subject</th>
              <th style="border:1px solid #ddd;padding:4px;">Code / ISBN</th>
              <th style="border:1px solid #ddd;padding:4px;">Ordered</th>
              <th style="border:1px solid #ddd;padding:4px;">Received</th>
              <th style="border:1px solid #ddd;padding:4px;">Pending</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>

        <p style="margin-top:16px;">
          Regards,<br/>
          EduBridge ERP<br/>
          ${supportEmail ? `Email: ${supportEmail}<br/>` : ""}
        </p>
      `;

      // 👉 Build publisher-wise PDF buffer using same helper as /pdf endpoint
      const pdfBuffer = await buildSchoolOrderPdfBuffer({
        order,
        school,
        companyProfile,
        items: itemsForPublisher,
        pdfTitle: `Purchase Order – ${publisher.name}`,
        publisherNameForHeader: publisher.name,
        dateStr: todayStr,
        orderDate,
      });

      const fileSuffix = `-publisher-${String(publisher.id).replace(
        /[^\w\-]+/g,
        "_"
      )}`;
      const filename = `school-order-${safeOrderNo}${fileSuffix}.pdf`;

      // CC yourself so you can see the mail coming & debug if needed
      const cc =
        process.env.PUBLISHER_ORDER_CC ||
        process.env.ORDER_EMAIL_CC ||
        process.env.SMTP_USER;

      const info = await sendMail({
        to: toEmail,
        cc,
        subject,
        html,
        replyTo: supportEmail || undefined,
        attachments: [
          {
            filename,
            content: pdfBuffer,
            contentType: "application/pdf",
          },
        ],
      });

      // Optional: mark order as sent
      try {
        order.status = "sent";
        if ("email_sent_at" in order) {
          order.email_sent_at = new Date();
        }
        await order.save();
      } catch (statusErr) {
        console.warn("Order status/email_sent_at update failed:", statusErr);
      }

      return reply.code(200).send({
        message: "Publisher order email (with PDF) sent successfully.",
        order_id: order.id,
        publisher_id: publisher.id,
        to: toEmail,
        message_id: info.messageId,
      });
    }

    /* =======================================================
     * 2) EMAIL TO SCHOOL (no publisher_id)
     *    + FULL ORDER PDF ATTACHED
     * ======================================================= */
    if (!school) {
      return reply.code(400).send({
        message: "School record not linked with this order.",
      });
    }

    if (!school.email) {
      return reply.code(400).send({
        message: "School does not have an email address.",
      });
    }

    const subject = `Book Order ${order.order_no || order.id} – ${
      school.name
    }`;

    // Transport block (same as before)
    const transportLines = [];
    const tObj = order.transport;

    const transportThrough = order.transport_through || null;
    const transportName = tObj?.name || null;
    const transportCity = tObj?.city || null;
    const transportPhone = tObj?.phone || null;

    if (transportThrough) {
      transportLines.push(
        `<div><strong>Through:</strong> ${transportThrough}</div>`
      );
    } else if (transportName) {
      transportLines.push(
        `<div><strong>Through:</strong> ${transportName}${
          transportCity ? " (" + transportCity + ")" : ""
        }</div>`
      );
    }

    if (transportPhone) {
      transportLines.push(
        `<div><strong>Transport Phone:</strong> ${transportPhone}</div>`
      );
    }

    if (order.notes) {
      transportLines.push(
        `<div><strong>Notes:</strong> ${String(order.notes).replace(
          /\n/g,
          "<br/>"
        )}</div>`
      );
    }

    const transportBlock =
      transportLines.length > 0
        ? `<h3 style="margin-top:18px;">Transport / Dispatch Details</h3>
           ${transportLines.join("\n")}`
        : "";

    const plainOrder = order.toJSON();

    const html = `
      <p>Dear ${school.name},</p>
      <p>Please find your book order details below:</p>

      <h3>Order Summary</h3>
      <div><strong>Order No:</strong> ${order.order_no || order.id}</div>
      <div><strong>Session:</strong> ${
        order.academic_session || "-"
      }</div>
      <div><strong>Order Date:</strong> ${orderDate}</div>
      <div><strong>Print Date:</strong> ${todayStr}</div>
      <div><strong>Status:</strong> ${order.status}</div>
      ${
        supportEmail
          ? `<div><strong>For any query, please write to:</strong> ${supportEmail}</div>`
          : ""
      }

      ${transportBlock}

      <h3 style="margin-top:18px;">Items</h3>
      <pre style="font-size:11px; background:#f7f7f7; padding:8px; border-radius:4px;">
${JSON.stringify(
  (plainOrder.items || []).map((it) => ({
    title: it.book?.title,
    class: it.book?.class_name,
    subject: it.book?.subject,
    publisher: it.book?.publisher?.name,
    code: it.book?.code || it.book?.isbn,
    ordered_qty: it.total_order_qty,
    received_qty: it.received_qty,
  })),
  null,
  2
)}
      </pre>
    `;

    // 👉 Build full-order PDF buffer (same as clicking PDF without publisher_id)
    const pdfBuffer = await buildSchoolOrderPdfBuffer({
      order,
      school,
      companyProfile,
      items,
      pdfTitle: "School Book Order",
      publisherNameForHeader: "",
      dateStr: todayStr,
      orderDate,
    });

    const filename = `school-order-${safeOrderNo}.pdf`;

    const cc = process.env.ORDER_EMAIL_CC || undefined;

    const info = await sendMail({
      to: school.email,
      cc,
      subject,
      html,
      replyTo: supportEmail || undefined,
      attachments: [
        {
          filename,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    });

    try {
      order.status = "sent";
      if ("email_sent_at" in order) {
        order.email_sent_at = new Date();
      }
      await order.save();
    } catch (statusErr) {
      console.warn("Order status/email_sent_at update failed:", statusErr);
    }

    return reply.code(200).send({
      message: "School order email (with PDF) sent successfully.",
      order_id: order.id,
      school_id: school.id,
      to: school.email,
      message_id: info.messageId,
    });
  } catch (err) {
    console.error("Error in sendOrderEmailForOrder:", err);
    return reply.code(500).send({
      error: "Error",
      message: err.message || "Failed to send school order email.",
    });
  }
};

/* ============================================================
 * Helper to build PDF into a Buffer (no streaming to reply here)
 * ============================================================ */
function buildSchoolOrderPdfBuffer({
  order,
  school, // still passed but NOT printed now
  companyProfile,
  items,
  pdfTitle,
  publisherNameForHeader,
  dateStr,
  orderDate,
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];

    doc.on("data", (chunk) => {
      chunks.push(chunk);
    });

    doc.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    doc.on("error", (err) => {
      reject(err);
    });

    /* ---------- Header: Company Profile ---------- */
    if (companyProfile) {
      const addrParts = [];

      if (companyProfile.address_line1)
        addrParts.push(companyProfile.address_line1);
      if (companyProfile.address_line2)
        addrParts.push(companyProfile.address_line2);

      const cityStatePin = [
        companyProfile.city,
        companyProfile.state,
        companyProfile.pincode,
      ]
        .filter(Boolean)
        .join(", ");

      if (cityStatePin) addrParts.push(cityStatePin);

      const addressLine = addrParts.join(", ");

      doc.font("Helvetica-Bold").fontSize(14).text(companyProfile.name || "", {
        align: "left",
      });

      doc.moveDown(0.1);

      if (addressLine) {
        doc.font("Helvetica").fontSize(9).text(addressLine, {
          align: "left",
        });
      }

      if (companyProfile.phone_primary || companyProfile.email) {
        const contactParts = [];
        if (companyProfile.phone_primary)
          contactParts.push(`Phone: ${companyProfile.phone_primary}`);
        if (companyProfile.email)
          contactParts.push(`Email: ${companyProfile.email}`);

        doc
          .font("Helvetica")
          .fontSize(9)
          .text(contactParts.join(" | "), { align: "left" });
      }

      if (companyProfile.gstin) {
        doc
          .font("Helvetica")
          .fontSize(9)
          .text(`GSTIN: ${companyProfile.gstin}`, { align: "left" });
      }

      doc.moveDown(0.5);
      doc
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .stroke();
      doc.moveDown(0.5);
    }

    /* ---------- Main title (center) ---------- */
    doc.font("Helvetica-Bold").fontSize(16).text(pdfTitle, {
      align: "center",
    });
    doc.moveDown(0.4);

    /* ---------- "To: Publisher" block (if publisher-wise) ---------- */
    if (publisherNameForHeader) {
      doc.font("Helvetica").fontSize(10).text("To,", { align: "left" });
      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .text(publisherNameForHeader, { align: "left" });
      doc.moveDown(0.3);
    }

    // ❌ School name / city REMOVED

    /* ---------- Order meta (kept) ---------- */
    doc
      .font("Helvetica")
      .fontSize(9)
      .text(`Order No: ${order.order_no || order.id}`, { align: "center" });

    if (order.academic_session) {
      doc
        .font("Helvetica")
        .fontSize(9)
        .text(`Session: ${order.academic_session}`, { align: "center" });
    }

    doc
      .font("Helvetica")
      .fontSize(9)
      .text(`Order Date: ${orderDate}`, { align: "center" });

    doc
      .font("Helvetica")
      .fontSize(9)
      .text(`Print Date: ${dateStr}`, { align: "center" });

    doc.moveDown(0.7);
    doc
      .moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .stroke();
    doc.moveDown(0.5);

    /* ---------- Status + totals (based on filtered items) ---------- */
    const totalOrdered = items.reduce(
      (sum, it) => sum + (Number(it.total_order_qty) || 0),
      0
    );
    const totalReceived = items.reduce(
      (sum, it) => sum + (Number(it.received_qty) || 0),
      0
    );
    const totalPending = Math.max(totalOrdered - totalReceived, 0);

    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .text(`Status: ${order.status}`, { align: "left" });
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(9).text(`Total Ordered Qty: ${totalOrdered}`);
    doc
      .font("Helvetica")
      .fontSize(9)
      .text(`Total Received Qty: ${totalReceived}`);
    doc.font("Helvetica").fontSize(9).text(`Pending Qty: ${totalPending}`);
    doc.moveDown(0.4);

    /* ---------- Transport / Notes (ONLY IF PRESENT) ---------- */
    const transportLines = [];
    const transportThrough = order.transport_through || null;
    const transportName =
      order.transport?.name || (order.transport_name || null);
    const transportCity = order.transport?.city || null;
    const transportPhone = order.transport?.phone || null;

    if (transportThrough) {
      transportLines.push(`Through: ${transportThrough}`);
    } else if (transportName) {
      transportLines.push(
        `Through: ${transportName}${
          transportCity ? " (" + transportCity + ")" : ""
        }`
      );
    }

    if (transportPhone) {
      transportLines.push(`Transport Phone: ${transportPhone}`);
    }

    if (order.notes) {
      transportLines.push(`Notes: ${order.notes}`);
    }

    if (transportLines.length > 0) {
      doc.moveDown(0.2);
      doc.font("Helvetica-Bold").fontSize(10).text("Transport / Dispatch Details");
      doc.moveDown(0.15);
      doc.font("Helvetica").fontSize(9);
      transportLines.forEach((line) => {
        doc.text(line, { align: "left" });
      });
      doc.moveDown(0.5);
    } else {
      doc.moveDown(0.4);
    }

    /* ---------- Table helpers ---------- */
    const printTableHeader = () => {
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(9);

      doc.text("Sr", 40, y, { width: 20 });
      doc.text("Book Title", 65, y, { width: 210 });
      doc.text("Class", 280, y, { width: 45 });
      doc.text("Subject", 325, y, { width: 70 });
      doc.text("Code / ISBN", 395, y, { width: 80 });
      doc.text("Publisher", 475, y, { width: 80 });
      doc.text("Ordered", 555, y, { width: 40, align: "right" });
      doc.text("Recv", 595, y, { width: 40, align: "right" });
      doc.text("Pend", 635, y, { width: 40, align: "right" });

      doc.moveDown(0.4);
      doc
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .stroke();
      doc.moveDown(0.3);
    };

    const ensureSpaceForRow = (approxHeight = 18) => {
      const bottom = doc.page.height - doc.page.margins.bottom;
      if (doc.y + approxHeight > bottom) {
        doc.addPage();
        printTableHeader();
      }
    };

    /* ---------- Table: Books details ---------- */
    printTableHeader();

    if (!items.length) {
      doc
        .font("Helvetica")
        .fontSize(10)
        .text("No items found in this order.", { align: "left" });
    } else {
      let sr = 1;
      for (const it of items) {
        ensureSpaceForRow(18);
        const y = doc.y;
        const orderedQty = Number(it.total_order_qty) || 0;
        const receivedQty = Number(it.received_qty) || 0;
        const pendingQty = Math.max(orderedQty - receivedQty, 0);

        doc.font("Helvetica").fontSize(9);

        doc.text(String(sr), 40, y, { width: 20 });
        doc.text(it.book?.title || `Book #${it.book_id}`, 65, y, {
          width: 210,
        });
        doc.text(it.book?.class_name || "-", 280, y, { width: 45 });
        doc.text(it.book?.subject || "-", 325, y, { width: 70 });
        doc.text(it.book?.code || it.book?.isbn || "-", 395, y, {
          width: 80,
        });
        doc.text(it.book?.publisher?.name || "-", 475, y, { width: 80 });
        doc.text(String(orderedQty), 555, y, { width: 40, align: "right" });
        doc.text(String(receivedQty), 595, y, { width: 40, align: "right" });
        doc.text(String(pendingQty), 635, y, { width: 40, align: "right" });

        doc.moveDown(0.7);
        sr++;
      }
    }

    // ✅ Finish PDF, triggers 'end' → resolve(buffer)
    doc.end();
  });
}

/* ============================================
 * GET /api/school-orders/:orderId/pdf
 * School-wise OR Publisher-wise PDF for a single school order
 * Query:
 *   ?publisher_id=8  (optional)
 * ============================================ */
exports.printOrderPdf = async (request, reply) => {
  const { orderId } = request.params;
  const { publisher_id } = request.query || {};

  try {
    // 1) Load order + company profile
    const order = await SchoolOrder.findOne({
      where: { id: orderId },
      include: [
        {
          model: School,
          as: "school",
          attributes: ["id", "name", "city"],
        },
        {
          model: SchoolOrderItem,
          as: "items",
          include: [
            {
              model: Book,
              as: "book",
              attributes: [
                "id",
                "title",
                "class_name",
                "subject",
                "code",
                "isbn",
                "publisher_id",
              ],
              include: [
                {
                  model: Publisher,
                  as: "publisher",
                  attributes: ["id", "name"],
                },
              ],
            },
          ],
        },
        {
          model: Transport,
          as: "transport",
        },
      ],
      order: [[{ model: SchoolOrderItem, as: "items" }, "id", "ASC"]],
    });

    const companyProfile = await CompanyProfile.findOne({
      where: { is_active: true },
      order: [
        ["is_default", "DESC"],
        ["id", "ASC"],
      ],
    });

    if (!order) {
      return reply
        .code(404)
        .send({ error: "NotFound", message: "School order not found" });
    }

    const school = order.school;
    let items = order.items || [];

    // ---------- Publisher filter ----------
    let pdfTitle = "School Book Order";
    let publisherNameForHeader = "";

    if (publisher_id) {
      const pid = Number(publisher_id);
      if (!Number.isNaN(pid)) {
        items = items.filter(
          (it) =>
            it.book &&
            (Number(it.book.publisher_id) === pid ||
              Number(it.book.publisher?.id) === pid)
        );

        if (!items.length) {
          return reply.code(400).send({
            error: "NoItems",
            message:
              "No items found in this order for the selected publisher.",
          });
        }

        publisherNameForHeader =
          items[0].book?.publisher?.name || `Publisher #${pid}`;
        pdfTitle = `Purchase Order – ${publisherNameForHeader}`;
      }
    }

    const today = new Date();
    const dateStr = today.toLocaleDateString("en-IN");
    const orderDate = order.order_date
      ? new Date(order.order_date).toLocaleDateString("en-IN")
      : "-";

    // ---------- Prepare filename ----------
    const safeOrderNo = String(
      order.order_no || `order-${order.id}`
    ).replace(/[^\w\-]+/g, "_");

    const suffix = publisher_id
      ? `-publisher-${String(publisher_id).replace(/[^\w\-]+/g, "_")}`
      : "";

    // ---------- Build PDF buffer (await, no streaming to reply) ----------
    const pdfBuffer = await buildSchoolOrderPdfBuffer({
      order,
      school,
      companyProfile,
      items,
      pdfTitle,
      publisherNameForHeader,
      dateStr,
      orderDate,
    });

    // ---------- Send response once ----------
    reply
      .header("Content-Type", "application/pdf")
      .header(
        "Content-Disposition",
        `inline; filename="school-order-${safeOrderNo}${suffix}.pdf"`
      )
      .send(pdfBuffer);

    return reply;
  } catch (err) {
    request.log.error({ err }, "Error in printOrderPdf");
    if (!reply.sent) {
      return reply.code(500).send({
        error: "InternalServerError",
        message: err.message || "Failed to generate school order PDF",
      });
    }
  }
};
