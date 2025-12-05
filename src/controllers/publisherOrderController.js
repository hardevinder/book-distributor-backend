// src/controllers/publisherOrderController.js

const {
  SchoolBookRequirement,
  Book,
  Publisher,
  PublisherOrder,
  PublisherOrderItem,
  RequirementOrderLink,
  sequelize,
} = require("../models");

const { sendMail } = require("../config/email");
const {
  buildPublisherOrderEmailHtml,
} = require("../utils/publisherOrderEmailTemplate");

// Simple order number generator – you can customise later
function generateOrderNo(publisherId, academicSession) {
  const ts = Date.now();
  const sessionPart = academicSession
    ? academicSession.replace(/[^0-9]/g, "")
    : "NA";
  return `PO-${publisherId}-${sessionPart}-${ts}`;
}

/* ============================================
 * Helper: recompute order status from items
 * ============================================ */
async function recomputeOrderStatus(order, t) {
  const fresh = await PublisherOrder.findOne({
    where: { id: order.id },
    include: [
      {
        model: PublisherOrderItem,
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

  // If already cancelled, don't auto-change
  if (fresh.status === "cancelled") {
    return fresh;
  }

  if (totalReceived === 0) {
    // nothing received yet
    if (fresh.status === "draft") {
      fresh.status = "draft";
    } else {
      fresh.status = "sent";
    }
  } else if (totalReceived < totalOrdered) {
    // 👉 140 ordered, 125 received → partial_received
    fresh.status = "partial_received";
  } else if (totalReceived === totalOrdered) {
    fresh.status = "completed";
  }

  await fresh.save({ transaction: t });
  return fresh;
}

/* ============================================
 * 🔹 GET /api/publisher-orders
 * List all publisher orders with publisher + items + book
 * ============================================ */
exports.listPublisherOrders = async (request, reply) => {
  try {
    const orders = await PublisherOrder.findAll({
      include: [
        {
          model: Publisher,
          as: "publisher",
        },
        {
          model: PublisherOrderItem,
          as: "items",
          include: [
            {
              model: Book,
              as: "book",
            },
          ],
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    return reply.code(200).send(orders);
  } catch (err) {
    console.error("Error in listPublisherOrders:", err);
    return reply.code(500).send({
      error: "Error",
      message: err.message || "Failed to load publisher orders.",
    });
  }
};

/* ============================================
 * 🔹 POST /api/publisher-orders/generate
 * Generate publisher-wise orders from confirmed school requirements
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
    // 1) Load all confirmed requirements for this session, with book + publisher
    const requirements = await SchoolBookRequirement.findAll({
      where: {
        academic_session: session,
        status: "confirmed",
      },
      include: [
        {
          model: Book,
          as: "book",
          include: [
            {
              model: Publisher,
              as: "publisher",
            },
          ],
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

    // 2) Group requirements by publisher_id + book_id
    const mapByPublisher = new Map();

    for (const reqRow of requirements) {
      const book = reqRow.book;
      if (!book || !book.publisher) continue;

      const publisherId = book.publisher.id;
      const bookId = book.id;

      if (!mapByPublisher.has(publisherId)) {
        mapByPublisher.set(publisherId, {
          books: new Map(),
        });
      }

      const publisherBucket = mapByPublisher.get(publisherId);

      if (!publisherBucket.books.has(bookId)) {
        publisherBucket.books.set(bookId, {
          totalQty: 0,
          requirementRows: [],
        });
      }

      const bookBucket = publisherBucket.books.get(bookId);
      bookBucket.totalQty += reqRow.required_copies || 0;
      bookBucket.requirementRows.push(reqRow);
    }

    const createdOrders = [];

    // 3) For each publisher create PublisherOrder + items
    for (const [publisherId, data] of mapByPublisher.entries()) {
      const orderNo = generateOrderNo(publisherId, session);

      const order = await PublisherOrder.create(
        {
          publisher_id: publisherId,
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
        const item = await PublisherOrderItem.create(
          {
            publisher_order_id: order.id,
            book_id: bookId,
            total_order_qty: bookData.totalQty,
            received_qty: 0, // start with 0 received
            unit_price: null,
            total_amount: null,
          },
          { transaction: t }
        );

        for (const reqRow of bookData.requirementRows) {
          linksToCreate.push({
            requirement_id: reqRow.id,
            publisher_order_item_id: item.id,
            allocated_qty: reqRow.required_copies || 0,
          });
          requirementIdsToUpdate.add(reqRow.id);
        }
      }

      if (linksToCreate.length) {
        await RequirementOrderLink.bulkCreate(linksToCreate, {
          transaction: t,
        });
      }

      if (requirementIdsToUpdate.size > 0) {
        await SchoolBookRequirement.update(
          { status: "confirmed" }, // later you can change to "ordered"
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
      message: "Publisher orders generated successfully.",
      academic_session: session,
      orders_count: createdOrders.length,
      orders: createdOrders,
    });
  } catch (err) {
    try {
      if (!t.finished) {
        await t.rollback();
      }
    } catch (rollbackErr) {
      console.error(
        "Rollback error in generateOrdersForSession:",
        rollbackErr
      );
    }

    console.error("Error in generateOrdersForSession:", err);
    return reply.code(500).send({
      error: "Error",
      message: err.message || "Failed to generate publisher orders.",
    });
  }
};

/* ============================================
 * 🔹 POST /api/publisher-orders/:orderId/receive
 * Update received quantities + order status
 * ============================================ */
/**
 * Body:
 * {
 *   "items": [
 *     { "item_id": 10, "received_qty": 50 },
 *     { "item_id": 11, "received_qty": 20 }
 *   ],
 *   "status": "auto" | "cancelled"
 * }
 */
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
    // Load order with items for locking
    const order = await PublisherOrder.findOne({
      where: { id: orderId },
      include: [
        {
          model: PublisherOrderItem,
          as: "items",
        },
      ],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!order) {
      await t.rollback();
      return reply.code(404).send({
        message: "Publisher order not found.",
      });
    }

    // Map for quick lookup
    const itemById = new Map();
    for (const it of order.items || []) {
      itemById.set(it.id, it);
    }

    // Update each item (clamp 0..total_order_qty)
    for (const row of items) {
      const itemId = row.item_id;
      let receivedQty = Number(row.received_qty ?? 0);

      if (!itemId || isNaN(receivedQty) || receivedQty < 0) continue;

      const item = itemById.get(itemId);
      if (!item) continue;

      const ordered = Number(item.total_order_qty) || 0;

      if (receivedQty > ordered) {
        receivedQty = ordered;
      }

      item.received_qty = receivedQty;
      await item.save({ transaction: t });
    }

    // If explicit cancel
    if (status === "cancelled") {
      order.status = "cancelled";
      await order.save({ transaction: t });
    } else {
      // auto recompute: completed / partial_received / sent / draft
      await recomputeOrderStatus(order, t);
    }

    // reload full order with publisher + book for response
    const updated = await PublisherOrder.findOne({
      where: { id: orderId },
      include: [
        { model: Publisher, as: "publisher" },
        {
          model: PublisherOrderItem,
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
      if (!t.finished) {
        await t.rollback();
      }
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
 * 🔹 POST /api/publisher-orders/:orderId/reorder-pending
 * Create a NEW PO for pending quantity of this order
 * ============================================ */
exports.reorderPendingForOrder = async (request, reply) => {
  const { orderId } = request.params;

  const t = await sequelize.transaction();

  try {
    // Load original order with items + publisher
    const sourceOrder = await PublisherOrder.findOne({
      where: { id: orderId },
      include: [
        {
          model: Publisher,
          as: "publisher",
        },
        {
          model: PublisherOrderItem,
          as: "items",
        },
      ],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!sourceOrder) {
      await t.rollback();
      return reply.code(404).send({
        message: "Publisher order not found.",
      });
    }

    // Calculate pending qty per item
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

    // Create new order for pending qty
    const publisherId = sourceOrder.publisher_id;
    const session = sourceOrder.academic_session || null;

    const newOrderNo = generateOrderNo(publisherId, session || "NA");

    const newOrder = await PublisherOrder.create(
      {
        publisher_id: publisherId,
        order_no: newOrderNo,
        academic_session: session,
        order_date: new Date(),
        status: "draft",
        remarks: `Re-order for pending quantity of ${sourceOrder.order_no}`,
      },
      { transaction: t }
    );

    // Create items for each pending line
    for (const row of pendingItems) {
      await PublisherOrderItem.create(
        {
          publisher_order_id: newOrder.id,
          book_id: row.book_id,
          total_order_qty: row.pending_qty,
          received_qty: 0,
          unit_price: null,
          total_amount: null,
        },
        { transaction: t }
      );
    }

    // Reload new order with publisher + items + book for response
    const fullNewOrder = await PublisherOrder.findOne({
      where: { id: newOrder.id },
      include: [
        {
          model: Publisher,
          as: "publisher",
        },
        {
          model: PublisherOrderItem,
          as: "items",
          include: [
            {
              model: Book,
              as: "book",
            },
          ],
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
      if (!t.finished) {
        await t.rollback();
      }
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
 * 🔹 POST /api/publisher-orders/:orderId/send-email
 * Send this specific publisher order via email
 * ============================================ */
exports.sendOrderEmailForOrder = async (request, reply) => {
  const { orderId } = request.params;

  try {
    const order = await PublisherOrder.findOne({
      where: { id: orderId },
      include: [
        {
          model: Publisher,
          as: "publisher",
        },
        {
          model: PublisherOrderItem,
          as: "items",
          include: [
            {
              model: Book,
              as: "book",
            },
          ],
        },
      ],
    });

    if (!order) {
      return reply.code(404).send({
        message: "Publisher order not found.",
      });
    }

    const publisher = order.publisher;
    if (!publisher) {
      return reply.code(400).send({
        message: "Publisher record not linked with this order.",
      });
    }

    if (!publisher.email) {
      return reply.code(400).send({
        message: "Publisher does not have an email address.",
      });
    }

    const subject = `Purchase Order ${order.order_no || order.id} – ${
      publisher.name
    }`;

    const html = buildPublisherOrderEmailHtml(order);
    const cc = process.env.ORDER_EMAIL_CC || undefined;

    const fromEmail =
      process.env.SMTP_FROM ||
      process.env.SMTP_USER ||
      "admin@edubridgeerp.in";

    const info = await sendMail({
      from: `"EduBridge ERP – Orders" <${fromEmail}>`,
      to: publisher.email,
      cc,
      subject,
      html,
    });

    try {
      order.status = "sent";
      // optional field, only if you added email_sent_at in model
      if ("email_sent_at" in order) {
        order.email_sent_at = new Date();
      }
      await order.save();
    } catch (statusErr) {
      console.warn("Order status/email_sent_at update failed:", statusErr);
    }

    return reply.code(200).send({
      message: "Purchase order email sent successfully.",
      order_id: order.id,
      publisher_id: publisher.id,
      to: publisher.email,
      message_id: info.messageId,
    });
  } catch (err) {
    console.error("Error in sendOrderEmailForOrder:", err);
    return reply.code(500).send({
      error: "Error",
      message: err.message || "Failed to send publisher order email.",
    });
  }
};
