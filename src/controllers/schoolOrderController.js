// src/controllers/schoolOrderController.js

const {
  SchoolBookRequirement,
  Book,
  School,
  SchoolOrder,
  SchoolOrderItem,
  SchoolRequirementOrderLink,
  sequelize,
} = require("../models");

const { sendMail } = require("../config/email");

// Later you can make a fancy HTML template:
// const { buildSchoolOrderEmailHtml } = require("../utils/schoolOrderEmailTemplate");

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
 * SIMPLE LIST (no includes for now)
 * ============================================ */
exports.listSchoolOrders = async (request, reply) => {
  try {
    const orders = await SchoolOrder.findAll({
      order: [["createdAt", "DESC"]],
    });

    return reply.code(200).send(orders);
  } catch (err) {
    // Better logging + safe message
    request.log.error({ err }, "❌ Error in listSchoolOrders");
    return reply.code(500).send({
      error: "Error",
      message: err.message || "Failed to load school orders.",
    });
  }
};

/* ============================================
 * POST /api/school-orders/generate
 * Generate SCHOOL-wise orders from confirmed requirements
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

    // Group by school_id + book_id
    const mapBySchool = new Map();

    for (const reqRow of requirements) {
      const schoolId = reqRow.school_id;
      const book = reqRow.book;
      if (!schoolId || !book) continue;

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
      bookBucket.totalQty += reqRow.required_copies || 0;
      bookBucket.requirementRows.push(reqRow);
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
        const item = await SchoolOrderItem.create(
          {
            school_order_id: order.id,
            book_id: bookId,
            total_order_qty: bookData.totalQty,
            received_qty: 0,
            unit_price: null,
            total_amount: null,
          },
          { transaction: t }
        );

        for (const reqRow of bookData.requirementRows) {
          linksToCreate.push({
            requirement_id: reqRow.id,
            school_order_item_id: item.id,
            allocated_qty: reqRow.required_copies || 0,
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
          { status: "confirmed" }, // later can use "ordered" if you want
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
          include: [{ model: Book, as: "book" }],
        },
      ],
      transaction: t,
    });

    await t.commit();

    const plain = updated.toJSON();
    plain.items = (plain.items || []).map((it) => ({
      ...it,
      pending_qty:
        (Number(it.total_order_qty) || 0) - (Number(it.received_qty) || 0),
    }));

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
          include: [{ model: Book, as: "book" }],
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
 * ============================================ */
exports.sendOrderEmailForOrder = async (request, reply) => {
  const { orderId } = request.params;

  try {
    const order = await SchoolOrder.findOne({
      where: { id: orderId },
      include: [
        { model: School, as: "school" },
        {
          model: SchoolOrderItem,
          as: "items",
          include: [{ model: Book, as: "book" }],
        },
      ],
    });

    if (!order) {
      return reply.code(404).send({ message: "School order not found." });
    }

    const school = order.school;
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

    // temporary simple email body (you can replace with HTML template)
    const html = `<p>Dear ${school.name},</p>
      <p>Please find your book order details below:</p>
      <pre>${JSON.stringify(order.toJSON(), null, 2)}</pre>`;

    const cc = process.env.ORDER_EMAIL_CC || undefined;

    const fromEmail =
      process.env.SMTP_FROM ||
      process.env.SMTP_USER ||
      "admin@edubridgeerp.in";

    const info = await sendMail({
      from: `"EduBridge ERP – Orders" <${fromEmail}>`,
      to: school.email,
      cc,
      subject,
      html,
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
      message: "School order email sent successfully.",
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
