// src/controllers/schoolOrderController.js
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const PDFDocument = require("pdfkit");
const { Op } = require("sequelize");

const {
  SchoolBookRequirement,
  Book,
  School,
  SchoolOrder,
  SchoolOrderItem,
  SchoolRequirementOrderLink,
  Publisher,
  Supplier,
  CompanyProfile,
  Transport,

  // ✅ Module-2 inventory (availability only)
  InventoryBatch,

  sequelize,
} = require("../models");

const { sendMail } = require("../config/email");

/* ============================================
 * Helpers
 * ============================================ */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const toNullIfEmpty = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());

const normalizeEmailList = (v) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");

const validateEmailList = (list) => {
  const arr = normalizeEmailList(list)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!arr.length) return false;
  return arr.every(isValidEmail);
};

const getEmailLogModel = () => {
  // works whether you registered via models/index.js or not
  return sequelize?.models?.SchoolOrderEmailLog || null;
};

// ✅ SUPER SHORT order no (ONLY code)
function generateOrderNo() {
  return Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
}

// ✅ Avoid collisions (because 5 chars can duplicate)
async function generateUniqueOrderNo(t) {
  for (let i = 0; i < 12; i++) {
    const code = generateOrderNo();
    const exists = await SchoolOrder.findOne({
      where: { order_no: code },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!exists) return code;
  }
  return (
    generateOrderNo() +
    Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 2)
  );
}

// ✅ Stable signature to detect "no changes" per supplier-order
function buildItemsSignatureFromMap(bookQtyMap) {
  const pairs = Array.from(bookQtyMap.entries())
    .map(([bookId, qty]) => `${Number(bookId)}:${Number(qty) || 0}`)
    .sort();
  return pairs.join("|");
}

function buildItemsSignatureFromOrderItems(orderItems = []) {
  const pairs = (orderItems || [])
    .map((it) => `${Number(it.book_id)}:${Number(it.total_order_qty) || 0}`)
    .sort();
  return pairs.join("|");
}

/* ============================================================
 * LOGO helpers (URL / local path / base64 data-url)
 * ============================================================ */

function fetchUrlBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;

    lib
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchUrlBuffer(res.headers.location));
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`Logo download failed. HTTP ${res.statusCode}`));
        }

        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

async function loadLogoBuffer(logoRef) {
  if (!logoRef) return null;

  const s = String(logoRef).trim();

  // skip svg/webp (pdfkit unreliable)
  if (/\.(svg|webp)(\?.*)?$/i.test(s)) return null;

  // data url
  if (s.startsWith("data:image/")) {
    try {
      const base64 = s.split(",")[1];
      if (!base64) return null;
      return Buffer.from(base64, "base64");
    } catch {
      return null;
    }
  }

  // url
  if (s.startsWith("http://") || s.startsWith("https://")) {
    try {
      return await fetchUrlBuffer(s);
    } catch {
      return null;
    }
  }

  // local file
  const localPath = path.isAbsolute(s) ? s : path.join(process.cwd(), s);
  if (fs.existsSync(localPath)) {
    try {
      return fs.readFileSync(localPath);
    } catch {
      return null;
    }
  }

  return null;
}

/* ============================================
 * Helper: recompute order status from items
 * ============================================ */
async function recomputeOrderStatus(order, t) {
  const fresh = await SchoolOrder.findOne({
    where: { id: order.id },
    include: [{ model: SchoolOrderItem, as: "items" }],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

  const items = fresh?.items || [];

  if (!items.length) {
    fresh.status = "draft";
    await fresh.save({ transaction: t });
    return fresh;
  }

  const totalOrdered = items.reduce((sum, it) => sum + (Number(it.total_order_qty) || 0), 0);
  const totalReceived = items.reduce((sum, it) => sum + (Number(it.received_qty) || 0), 0);

  if (fresh.status === "cancelled") return fresh;

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
 * Supplier-wise listing
 * ============================================ */
exports.listSchoolOrders = async (request, reply) => {
  try {
    const { academic_session, school_id, status, supplier_id } = request.query || {};

    const where = {};
    if (academic_session) where.academic_session = academic_session;
    if (school_id) where.school_id = school_id;
    if (status) where.status = status;
    if (supplier_id) where.supplier_id = supplier_id;

    const orders = await SchoolOrder.findAll({
      where,
      include: [
        { model: School, as: "school" },
        { model: Supplier, as: "supplier" },
        {
          model: SchoolOrderItem,
          as: "items",
          include: [
            {
              model: Book,
              as: "book",
              include: [{ model: Publisher, as: "publisher", attributes: ["id", "name"] }],
            },
          ],
        },
        { model: Transport, as: "transport" },
        ...(SchoolOrder.associations?.transport2 ? [{ model: Transport, as: "transport2" }] : []),
      ],
      order: [
        [{ model: School, as: "school" }, "name", "ASC"],
        [{ model: Supplier, as: "supplier" }, "name", "ASC"],
        ["order_date", "DESC"],
        ["createdAt", "DESC"],
      ],
    });

    const plainOrders = orders.map((order) => {
      const o = order.toJSON();
      o.items =
        (o.items || []).map((it) => {
          const ordered = Number(it.total_order_qty) || 0;
          const received = Number(it.received_qty) || 0;
          const reordered = Number(it.reordered_qty) || 0;
          const pending = Math.max(ordered - received - reordered, 0);
          return { ...it, pending_qty: pending };
        }) || [];
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
 * ✅ Creates OR updates (sync) one ORIGINAL order per (school + supplier + session)
 * ✅ Safe: never touches reorder (order_type='reorder')
 * ============================================ */
exports.generateOrdersForSession = async (request, reply) => {
  const { academic_session } = request.body || {};

  if (!academic_session || !String(academic_session).trim()) {
    return reply.code(400).send({
      error: "ValidationError",
      message: "academic_session is required.",
    });
  }

  const session = String(academic_session).trim();
  const t = await sequelize.transaction();

  try {
    const requirements = await SchoolBookRequirement.findAll({
      where: { academic_session: session, status: "confirmed" },
      include: [
        {
          model: Book,
          as: "book",
          include: [{ model: Publisher, as: "publisher", attributes: ["id", "name"] }],
        },
        { model: School, as: "school" },
        { model: Supplier, as: "supplier" },
      ],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!requirements.length) {
      await t.rollback();
      return reply.code(200).send({
        message: "No confirmed requirements found for this session.",
        academic_session: session,
        created_count: 0,
        updated_count: 0,
        skipped_count: 0,
        created_orders: [],
        updated_orders: [],
        skipped_orders: [],
      });
    }

    // schoolId -> supplierId -> { books: Map(bookId->qty), reqRowsByBook: Map(bookId->[reqRow]) }
    const mapBySchool = new Map();

    for (const rr of requirements) {
      const schoolId = rr.school_id;
      const book = rr.book;
      if (!schoolId || !book) continue;

      const qty = Number(rr.required_copies || 0);
      if (!qty || qty <= 0) continue;

      const supplierId = Number(rr.supplier_id || 0);
      if (!supplierId) continue;

      if (!mapBySchool.has(schoolId)) mapBySchool.set(schoolId, new Map());
      const bySupplier = mapBySchool.get(schoolId);

      if (!bySupplier.has(supplierId)) {
        bySupplier.set(supplierId, { books: new Map(), reqRowsByBook: new Map() });
      }

      const bucket = bySupplier.get(supplierId);
      const bookId = book.id;

      bucket.books.set(bookId, (Number(bucket.books.get(bookId)) || 0) + qty);

      if (!bucket.reqRowsByBook.has(bookId)) bucket.reqRowsByBook.set(bookId, []);
      bucket.reqRowsByBook.get(bookId).push(rr);
    }

    const createdOrders = [];
    const updatedOrders = [];
    const skippedOrders = [];

    for (const [schoolId, bySupplier] of mapBySchool.entries()) {
      for (const [supplierId, data] of bySupplier.entries()) {
        const desiredSignature = buildItemsSignatureFromMap(data.books);

        // ✅ STRICT: only original orders
        const existing = await SchoolOrder.findOne({
          where: {
            school_id: schoolId,
            supplier_id: supplierId,
            academic_session: session,
            status: { [Op.ne]: "cancelled" },
            order_type: "original",
          },
          include: [{ model: SchoolOrderItem, as: "items" }],
          order: [["createdAt", "DESC"]],
          transaction: t,
          lock: t.LOCK.UPDATE,
        });

        if (existing) {
          const existingSig = buildItemsSignatureFromOrderItems(existing.items || []);

          if (existingSig === desiredSignature) {
            skippedOrders.push({
              order_id: existing.id,
              order_no: existing.order_no,
              school_id: existing.school_id,
              supplier_id: existing.supplier_id,
              academic_session: existing.academic_session,
              status: existing.status,
              reason: "No changes",
            });
            continue;
          }

          const hasReceived = (existing.items || []).some((it) => Number(it.received_qty || 0) > 0);
          if (hasReceived) {
            skippedOrders.push({
              order_id: existing.id,
              order_no: existing.order_no,
              school_id: existing.school_id,
              supplier_id: existing.supplier_id,
              academic_session: existing.academic_session,
              status: existing.status,
              reason: "Has received qty; not auto-updating original",
            });
            continue;
          }

          const existingItemsByBook = new Map();
          for (const it of existing.items || []) existingItemsByBook.set(Number(it.book_id), it);

          const linksToCreate = [];

          const oldItemIds = (existing.items || []).map((x) => x.id);
          if (oldItemIds.length) {
            await SchoolRequirementOrderLink.destroy({
              where: { school_order_item_id: oldItemIds },
              transaction: t,
            });
          }

          for (const [bookIdRaw, totalQtyRaw] of data.books.entries()) {
            const bookId = Number(bookIdRaw);
            const qty = Number(totalQtyRaw || 0);

            let item = existingItemsByBook.get(bookId);

            if (item) {
              item.total_order_qty = qty;
              item.received_qty = 0;
              await item.save({ transaction: t });
            } else {
              item = await SchoolOrderItem.create(
                {
                  school_order_id: existing.id,
                  book_id: bookId,
                  total_order_qty: qty,
                  received_qty: 0,
                },
                { transaction: t }
              );
            }

            const reqRows = data.reqRowsByBook.get(bookId) || [];
            for (const rr of reqRows) {
              const rqQty = Number(rr.required_copies || 0);
              if (!rqQty || rqQty <= 0) continue;

              linksToCreate.push({
                requirement_id: rr.id,
                school_order_item_id: item.id,
                allocated_qty: rqQty,
              });
            }
          }

          for (const it of existing.items || []) {
            const bId = Number(it.book_id);
            if (!data.books.has(bId)) {
              await SchoolRequirementOrderLink.destroy({
                where: { school_order_item_id: it.id },
                transaction: t,
              });
              await it.destroy({ transaction: t });
            }
          }

          if (linksToCreate.length) {
            await SchoolRequirementOrderLink.bulkCreate(linksToCreate, { transaction: t });
          }

          await existing.save({ transaction: t });

          updatedOrders.push({
            order_id: existing.id,
            order_no: existing.order_no,
            school_id: existing.school_id,
            supplier_id: existing.supplier_id,
            academic_session: existing.academic_session,
            status: existing.status,
          });

          continue;
        }

        const orderNo = await generateUniqueOrderNo(t);

        const order = await SchoolOrder.create(
          {
            school_id: schoolId,
            supplier_id: supplierId,
            order_no: orderNo,
            academic_session: session,
            order_date: new Date(),
            status: "draft",
            order_type: "original",
            parent_order_id: null,
            reorder_seq: null,
          },
          { transaction: t }
        );

        const linksToCreate = [];

        for (const [bookIdRaw, totalQtyRaw] of data.books.entries()) {
          const bookId = Number(bookIdRaw);
          const qty = Number(totalQtyRaw || 0);
          if (!qty || qty <= 0) continue;

          const item = await SchoolOrderItem.create(
            {
              school_order_id: order.id,
              book_id: bookId,
              total_order_qty: qty,
              received_qty: 0,
            },
            { transaction: t }
          );

          const reqRows = data.reqRowsByBook.get(bookId) || [];
          for (const rr of reqRows) {
            const rqQty = Number(rr.required_copies || 0);
            if (!rqQty || rqQty <= 0) continue;

            linksToCreate.push({
              requirement_id: rr.id,
              school_order_item_id: item.id,
              allocated_qty: rqQty,
            });
          }
        }

        if (linksToCreate.length) {
          await SchoolRequirementOrderLink.bulkCreate(linksToCreate, { transaction: t });
        }

        createdOrders.push(order);
      }
    }

    await t.commit();

    return reply.code(200).send({
      message: "Generate orders done (created/updated/skipped).",
      academic_session: session,
      created_count: createdOrders.length,
      updated_count: updatedOrders.length,
      skipped_count: skippedOrders.length,
      created_orders: createdOrders,
      updated_orders: updatedOrders,
      skipped_orders: skippedOrders,
    });
  } catch (err) {
    try {
      if (!t.finished) await t.rollback();
    } catch {}
    console.error("Error in generateOrdersForSession:", err);
    return reply.code(500).send({
      error: "Error",
      message: err.message || "Failed to generate orders.",
    });
  }
};

/* ============================================
 * PATCH /api/school-orders/:orderId/meta
 * ✅ notes + transports ONLY (Module-2)
 * ============================================ */
exports.updateSchoolOrderMeta = async (request, reply) => {
  const { orderId } = request.params;

  // ✅ UPDATED: accept notes_2
  const { transport_id, transport_id_2, notes, notes_2 } = request.body || {};

  try {
    const order = await SchoolOrder.findOne({ where: { id: orderId } });
    if (!order) return reply.code(404).send({ message: "School order not found." });

    // transport 1
    if (typeof transport_id !== "undefined") {
      const tidNum = transport_id === null || transport_id === "" ? null : Number(transport_id);
      order.transport_id = Number.isNaN(tidNum) ? null : tidNum;
    }

    // transport 2
    if (typeof transport_id_2 !== "undefined") {
      const tidNum2 =
        transport_id_2 === null || transport_id_2 === "" ? null : Number(transport_id_2);
      if ("transport_id_2" in order) {
        order.transport_id_2 = Number.isNaN(tidNum2) ? null : tidNum2;
      }
    }

    // notes (note 1)
    if (typeof notes !== "undefined") {
      order.notes = notes === null || notes === "" ? null : String(notes).trim();
    }

    // ✅ notes_2 (note 2)
    if (typeof notes_2 !== "undefined") {
      order.notes_2 = notes_2 === null || notes_2 === "" ? null : String(notes_2).trim();
    }

    await order.save();

    const updated = await SchoolOrder.findOne({
      where: { id: orderId },
      include: [
        { model: School, as: "school" },
        { model: Supplier, as: "supplier" },
        {
          model: SchoolOrderItem,
          as: "items",
          include: [
            {
              model: Book,
              as: "book",
              include: [{ model: Publisher, as: "publisher", attributes: ["id", "name"] }],
            },
          ],
        },
        { model: Transport, as: "transport" },
        ...(SchoolOrder.associations?.transport2 ? [{ model: Transport, as: "transport2" }] : []),
      ],
    });

    const plain = updated.toJSON();
    plain.items =
      (plain.items || []).map((it) => {
        const ordered = Number(it.total_order_qty) || 0;
        const received = Number(it.received_qty) || 0;
        const reordered = Number(it.reordered_qty) || 0;
        const pending = Math.max(ordered - received - reordered, 0);
        return { ...it, pending_qty: pending };
      }) || [];

    return reply.code(200).send({ message: "Order meta updated successfully.", order: plain });
  } catch (err) {
    console.error("Error in updateSchoolOrderMeta:", err);
    return reply.code(500).send({
      error: "Error",
      message: err.message || "Failed to update order meta.",
    });
  }
};

/* ============================================
 * PATCH /api/school-orders/:orderId/order-no
 * ============================================ */
exports.updateSchoolOrderNo = async (request, reply) => {
  const { orderId } = request.params;
  const { order_no } = request.body || {};

  const newNo = String(order_no || "").trim();
  if (!newNo) {
    return reply.code(400).send({ error: "ValidationError", message: "order_no is required." });
  }

  try {
    const order = await SchoolOrder.findByPk(orderId);
    if (!order) return reply.code(404).send({ message: "School order not found." });

    const dup = await SchoolOrder.findOne({
      where: { order_no: newNo, id: { [Op.ne]: order.id } },
    });
    if (dup) {
      return reply.code(400).send({
        error: "DuplicateOrderNo",
        message: "This order number already exists.",
      });
    }

    order.order_no = newNo;
    await order.save();

    return reply.code(200).send({
      message: "Order number updated successfully.",
      order_id: order.id,
      order_no: order.order_no,
    });
  } catch (err) {
    console.error("Error in updateSchoolOrderNo:", err);
    return reply.code(500).send({
      error: "Error",
      message: err.message || "Failed to update order number.",
    });
  }
};

/* ============================================
 * POST /api/school-orders/:orderId/receive
 * ✅ PO RECEIVE ONLY (NO receipt, NO inventory in, NO supplier ledger)
 * ============================================ */
exports.receiveOrderItems = async (request, reply) => {
  const { orderId } = request.params;
  const { items, status = "auto" } = request.body || {};

  if (!items || !Array.isArray(items) || !items.length) {
    return reply.code(400).send({ error: "ValidationError", message: "items array is required." });
  }

  const isCancelled = status === "cancelled";
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

    const normalizedMap = new Map();
    for (const row of items) {
      const itemId = Number(row?.item_id || 0);
      if (!itemId) continue;
      normalizedMap.set(itemId, row);
    }
    const normalizedItems = Array.from(normalizedMap.entries()).map(([item_id, row]) => ({
      ...row,
      item_id,
    }));

    const itemById = new Map();
    for (const it of order.items || []) itemById.set(it.id, it);

    for (const row of normalizedItems) {
      const itemId = Number(row.item_id || 0);
      let newReceived = Number(row.received_qty ?? 0);

      if (!itemId || Number.isNaN(newReceived) || newReceived < 0) continue;

      const item = itemById.get(itemId);
      if (!item) continue;

      const ordered = Number(item.total_order_qty) || 0;
      newReceived = clamp(newReceived, 0, ordered);

      const oldReceived = Number(item.received_qty || 0);
      const delta = newReceived - oldReceived;

      if (delta < 0) {
        throw new Error(`Received qty cannot be reduced (Item #${item.id}).`);
      }

      item.received_qty = newReceived;
      await item.save({ transaction: t });
    }

    if (isCancelled) {
      order.status = "cancelled";
      await order.save({ transaction: t });
    } else {
      await recomputeOrderStatus(order, t);
      if ("received_at" in order && !order.received_at) order.received_at = new Date();
      await order.save({ transaction: t });
    }

    const updated = await SchoolOrder.findOne({
      where: { id: orderId },
      include: [
        { model: School, as: "school" },
        { model: Supplier, as: "supplier" },
        {
          model: SchoolOrderItem,
          as: "items",
          include: [
            {
              model: Book,
              as: "book",
              include: [{ model: Publisher, as: "publisher", attributes: ["id", "name"] }],
            },
          ],
        },
        { model: Transport, as: "transport" },
        ...(SchoolOrder.associations?.transport2 ? [{ model: Transport, as: "transport2" }] : []),
      ],
      transaction: t,
    });

    await t.commit();

    const plain = updated.toJSON();
    plain.items =
      (plain.items || []).map((it) => {
        const ordered = Number(it.total_order_qty) || 0;
        const received = Number(it.received_qty) || 0;
        const reordered = Number(it.reordered_qty) || 0;
        const pending = Math.max(ordered - received - reordered, 0);
        return { ...it, pending_qty: pending };
      }) || [];

    return reply.code(200).send({
      message: "PO receive updated successfully (Purchase separated).",
      order: plain,
    });
  } catch (err) {
    try {
      if (!t.finished) await t.rollback();
    } catch {}
    console.error("Error in receiveOrderItems (PO-only):", err);
    return reply.code(500).send({
      error: "Error",
      message: err.message || "Failed to update PO received items.",
    });
  }
};

/* ============================================
 * POST /api/school-orders/:orderId/reorder-pending
 * - Creates a new reorder order for pending qty
 * - ✅ Updates old order items.reordered_qty (shifts qty)
 * ============================================ */
exports.reorderPendingForOrder = async (request, reply) => {
  const { orderId } = request.params;
  const t = await sequelize.transaction();

  try {
    const sourceOrder = await SchoolOrder.findOne({
      where: { id: orderId, status: { [Op.ne]: "cancelled" } },
      include: [
        { model: School, as: "school" },
        { model: Supplier, as: "supplier" },
        { model: SchoolOrderItem, as: "items" },
      ],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!sourceOrder) {
      await t.rollback();
      return reply.code(404).send({ message: "School order not found." });
    }

    if (!sourceOrder.school_id || !sourceOrder.supplier_id) {
      await t.rollback();
      return reply.code(400).send({
        error: "ValidationError",
        message: "Order must have school_id and supplier_id to create re-order.",
      });
    }

    const bookMap = new Map();
    const shiftRows = [];

    for (const it of sourceOrder.items || []) {
      const ordered = Number(it.total_order_qty) || 0;
      const received = Number(it.received_qty) || 0;
      const alreadyReordered = Number(it.reordered_qty) || 0;

      const pending = ordered - received - alreadyReordered;

      if (pending > 0) {
        bookMap.set(it.book_id, (Number(bookMap.get(it.book_id)) || 0) + pending);
        shiftRows.push({ itemId: it.id, shiftQty: pending });
      }
    }

    if (!bookMap.size) {
      await t.rollback();
      return reply
        .code(400)
        .send({ message: "No pending quantity found to re-order for this order." });
    }

    const pendingSignature = buildItemsSignatureFromMap(bookMap);

    const latestReorder = await SchoolOrder.findOne({
      where: {
        school_id: sourceOrder.school_id,
        supplier_id: sourceOrder.supplier_id,
        academic_session: sourceOrder.academic_session || null,
        order_type: "reorder",
        status: { [Op.ne]: "cancelled" },
        parent_order_id: sourceOrder.id,
      },
      include: [{ model: SchoolOrderItem, as: "items" }],
      order: [["createdAt", "DESC"]],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (latestReorder) {
      const latestSig = buildItemsSignatureFromOrderItems(latestReorder.items || []);
      if (latestSig === pendingSignature) {
        await t.rollback();
        return reply.code(200).send({
          message: "Pending re-order already exists (no changes).",
          original_order_id: sourceOrder.id,
          existing_order_id: latestReorder.id,
          existing_order_no: latestReorder.order_no,
        });
      }
    }

    const newOrderNo = await generateUniqueOrderNo(t);

    const newOrder = await SchoolOrder.create(
      {
        school_id: sourceOrder.school_id,
        supplier_id: sourceOrder.supplier_id,
        order_no: newOrderNo,
        academic_session: sourceOrder.academic_session || null,
        order_date: new Date(),
        status: "draft",
        remarks: `Re-order for pending qty of ${sourceOrder.order_no || sourceOrder.id}`,
        order_type: "reorder",
        parent_order_id: sourceOrder.id,
      },
      { transaction: t }
    );

    for (const [bookId, qty] of bookMap.entries()) {
      const q = Number(qty || 0);
      if (!q || q <= 0) continue;

      await SchoolOrderItem.create(
        {
          school_order_id: newOrder.id,
          book_id: Number(bookId),
          total_order_qty: q,
          received_qty: 0,
          reordered_qty: 0,
        },
        { transaction: t }
      );
    }

    for (const s of shiftRows) {
      const it = (sourceOrder.items || []).find((x) => x.id === s.itemId);
      if (!it) continue;

      const current = Number(it.reordered_qty) || 0;
      it.reordered_qty = current + Number(s.shiftQty || 0);
      await it.save({ transaction: t });
    }

    const fullNewOrder = await SchoolOrder.findOne({
      where: { id: newOrder.id },
      include: [
        { model: School, as: "school" },
        { model: Supplier, as: "supplier" },
        {
          model: SchoolOrderItem,
          as: "items",
          include: [
            {
              model: Book,
              as: "book",
              include: [{ model: Publisher, as: "publisher", attributes: ["id", "name"] }],
            },
          ],
        },
        { model: Transport, as: "transport" },
        ...(SchoolOrder.associations?.transport2 ? [{ model: Transport, as: "transport2" }] : []),
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
    } catch {}
    console.error("Error in reorderPendingForOrder:", err);
    return reply.code(500).send({
      error: "Error",
      message: err.message || "Failed to create re-order for pending quantity.",
    });
  }
};

/* ============================================
 * ✅ NEW: POST /api/school-orders/:orderId/reorder-copy
 * ✅ Copy order with edited qty (does NOT touch old/pending)
 * body: { items: [{ item_id, total_order_qty }] }
 * ============================================ */
exports.reorderCopyWithEdit = async (request, reply) => {
  const { orderId } = request.params;
  const { items } = request.body || {};

  if (!Array.isArray(items) || !items.length) {
    return reply.code(400).send({ error: "ValidationError", message: "items array is required." });
  }

  const t = await sequelize.transaction();

  try {
    const sourceOrder = await SchoolOrder.findOne({
      where: { id: orderId, status: { [Op.ne]: "cancelled" } },
      include: [
        { model: School, as: "school" },
        { model: Supplier, as: "supplier" },
        { model: SchoolOrderItem, as: "items" },
      ],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!sourceOrder) {
      await t.rollback();
      return reply.code(404).send({ message: "School order not found." });
    }

    // Map source items by id (resolve book_id safely)
    const srcItemById = new Map();
    for (const it of sourceOrder.items || []) srcItemById.set(Number(it.id), it);

    // Normalize edited items: item_id -> qty
    const qtyByBook = new Map(); // book_id -> qty
    for (const row of items) {
      const itemId = Number(row?.item_id || 0);
      const qty = Number(row?.total_order_qty ?? row?.qty ?? 0);
      if (!itemId || Number.isNaN(qty) || qty < 0) continue;

      const srcIt = srcItemById.get(itemId);
      if (!srcIt) continue;

      const bookId = Number(srcIt.book_id);
      qtyByBook.set(bookId, qty);
    }

    if (!qtyByBook.size) {
      await t.rollback();
      return reply.code(400).send({ message: "No valid items found to copy." });
    }

    // next reorder_seq (per parent order)
    const last = await SchoolOrder.findOne({
      where: {
        parent_order_id: sourceOrder.id,
        order_type: "reorder",
        status: { [Op.ne]: "cancelled" },
      },
      order: [["reorder_seq", "DESC"], ["createdAt", "DESC"]],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    const nextSeq = (Number(last?.reorder_seq) || 0) + 1;

    const newOrderNo = await generateUniqueOrderNo(t);

    const newOrder = await SchoolOrder.create(
      {
        school_id: sourceOrder.school_id,
        supplier_id: sourceOrder.supplier_id,
        order_no: newOrderNo,
        academic_session: sourceOrder.academic_session || null,
        order_date: new Date(),
        status: "draft",
        remarks: `Re-order copy of ${sourceOrder.order_no || sourceOrder.id}`,
        order_type: "reorder",
        parent_order_id: sourceOrder.id,
        reorder_seq: nextSeq,
      },
      { transaction: t }
    );

    // Create new items with edited qty (skip 0)
    for (const [bookId, qty] of qtyByBook.entries()) {
      const q = Number(qty || 0);
      if (q <= 0) continue;

      await SchoolOrderItem.create(
        {
          school_order_id: newOrder.id,
          book_id: Number(bookId),
          total_order_qty: q,
          received_qty: 0,
          reordered_qty: 0,
        },
        { transaction: t }
      );
    }

    const fullNewOrder = await SchoolOrder.findOne({
      where: { id: newOrder.id },
      include: [
        { model: School, as: "school" },
        { model: Supplier, as: "supplier" },
        {
          model: SchoolOrderItem,
          as: "items",
          include: [
            {
              model: Book,
              as: "book",
              include: [{ model: Publisher, as: "publisher", attributes: ["id", "name"] }],
            },
          ],
        },
        { model: Transport, as: "transport" },
        ...(SchoolOrder.associations?.transport2 ? [{ model: Transport, as: "transport2" }] : []),
      ],
      transaction: t,
    });

    await t.commit();

    return reply.code(201).send({
      message: "Re-order copy created (edited qty). Original order unchanged.",
      original_order_id: sourceOrder.id,
      new_order: fullNewOrder,
    });
  } catch (err) {
    try {
      if (!t.finished) await t.rollback();
    } catch {}
    console.error("Error in reorderCopyWithEdit:", err);
    return reply.code(500).send({
      error: "Error",
      message: err.message || "Failed to create re-order copy.",
    });
  }
};

/* ============================================================
 * ✅ Module-2: School -> Book wise availability
 * GET /api/inventory/availability?school_id=&supplier_id=&q=
 * ============================================================ */
exports.getSchoolBookAvailability = async (request, reply) => {
  try {
    const { school_id, supplier_id, q } = request.query || {};

    if (!school_id) {
      return reply.code(400).send({
        error: "ValidationError",
        message: "school_id is required.",
      });
    }

    const whereBatch = {};
    if (supplier_id) whereBatch.supplier_id = Number(supplier_id);

    const rows = await InventoryBatch.findAll({
      where: whereBatch,
      include: [
        {
          model: SchoolOrder,
          as: "schoolOrder",
          required: true,
          where: { school_id: Number(school_id) },
          attributes: ["id", "school_id", "supplier_id", "order_no"],
        },
        {
          model: Book,
          as: "book",
          required: true,
          include: [{ model: Publisher, as: "publisher", attributes: ["id", "name"] }],
        },
        { model: Supplier, as: "supplier" },
      ],
      order: [[{ model: Book, as: "book" }, "title", "ASC"]],
    });

    const filtered = (rows || []).filter((r) => {
      if (!q) return true;
      const s = String(q).trim().toLowerCase();
      const b = r.book || {};
      const hay = `${b.title || ""} ${b.code || ""} ${b.isbn || ""}`.toLowerCase();
      return hay.includes(s);
    });

    const map = new Map();
    for (const r of filtered) {
      const b = r.book;
      const sup = r.supplier;
      const key = `${r.book_id}:${r.supplier_id || 0}`;
      if (!map.has(key)) {
        map.set(key, {
          book_id: r.book_id,
          supplier_id: r.supplier_id || null,
          book: b,
          supplier: sup,
          received_qty: 0,
          available_qty: 0,
        });
      }
      const obj = map.get(key);
      obj.received_qty += Number(r.received_qty || 0);
      obj.available_qty += Number(r.available_qty || 0);
    }

    return reply.code(200).send({
      school_id: Number(school_id),
      supplier_id: supplier_id ? Number(supplier_id) : null,
      count: map.size,
      rows: Array.from(map.values()),
    });
  } catch (err) {
    console.error("Error in getSchoolBookAvailability:", err);
    return reply.code(500).send({
      error: "Error",
      message: err.message || "Failed to load availability.",
    });
  }
};

// ✅ UPDATED: renderSchoolOrderToDoc (NO GAP BETWEEN ROWS + PROPER CONTINUOUS GRIDS)
// - Company name BIGGER (20)
// - Proper TABLE GRIDS (outer border + vertical + horizontal lines)
// - Ordered list (Sr. continuous across whole order; NOT reset per publisher)
// - ✅ Rows do NOT "break" (no space between rows)
// - Works with page breaks (reprints header + keeps grids aligned)

async function renderSchoolOrderToDoc(doc, opts) {
  const {
    order,
    companyProfile,
    items,
    pdfTitle,
    toParty,
    dateStr,
    orderDate,
    isPurchaseOrder = false,
    showPrintDate = false,
    showReceivedPending = true,

    // ✅ Notes override (two notes)
    notes = null,

    // ✅ Layout tweaks requested by client
    layout = {},
  } = opts || {};

  const L = {
    hideSubject: Boolean(layout?.hideSubject),
    summaryTotalOnly: Boolean(layout?.summaryTotalOnly),
    supplierAddressSecondColumn: Boolean(layout?.supplierAddressSecondColumn),
    boldSupplierName: Boolean(layout?.boldSupplierName),
    boldOrderDate: Boolean(layout?.boldOrderDate),

    // ✅ continuous Sr by default
    resetSrPerPublisher: Boolean(layout?.resetSrPerPublisher), // default false
    gridLineWidth: Number(layout?.gridLineWidth || 0.6),

    // ✅ tighter row padding (optional)
    rowPadY: Number(layout?.rowPadY ?? 3), // top padding inside row
    rowPadX: Number(layout?.rowPadX ?? 4), // left padding inside cell
  };

  const pageLeft = doc.page.margins.left;
  const pageRight = doc.page.width - doc.page.margins.right;
  const contentWidth = pageRight - pageLeft;

  const safeText = (v) => String(v ?? "").trim();

  const drawHR = () => {
    doc.save();
    doc.lineWidth(0.7);
    doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).stroke();
    doc.restore();
  };

  const drawHR2 = () => {
    doc.save();
    doc.lineWidth(0.6);
    doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).stroke();
    doc.restore();
  };

  const ensureSpaceWithHeader = (neededHeight, printHeaderFn) => {
    const bottom = doc.page.height - doc.page.margins.bottom;
    if (doc.y + neededHeight > bottom) {
      doc.addPage();
      if (typeof printHeaderFn === "function") printHeaderFn();
      return true;
    }
    return false;
  };

  // ✅ Draw table grid for a block [topY..bottomY] with vertical lines at Xs
  const drawTableGrid = (topY, bottomY, Xs, outerLeft, outerRight) => {
    doc.save();
    doc.lineWidth(L.gridLineWidth);
    doc.strokeColor("#000");

    // outer border
    doc
      .moveTo(outerLeft, topY)
      .lineTo(outerRight, topY)
      .lineTo(outerRight, bottomY)
      .lineTo(outerLeft, bottomY)
      .closePath()
      .stroke();

    // verticals
    for (const x of Xs) {
      if (x <= outerLeft || x >= outerRight) continue;
      doc.moveTo(x, topY).lineTo(x, bottomY).stroke();
    }

    doc.restore();
  };

  /* ---------- Header (logo + company) ---------- */
  if (companyProfile) {
    const startY = doc.y;
    const logoSize = 52;
    const gap = 10;

    const logoRef =
      companyProfile.logo_url ||
      companyProfile.logo ||
      companyProfile.logo_path ||
      companyProfile.logo_image ||
      null;

    let logoBuf = null;
    try {
      logoBuf = await loadLogoBuffer(logoRef);
    } catch {
      logoBuf = null;
    }

    const logoX = pageLeft;
    const logoY = startY;
    const textX = logoBuf ? logoX + logoSize + gap : pageLeft;
    const textWidth = pageRight - textX;

    if (logoBuf) {
      try {
        doc.image(logoBuf, logoX, logoY, { fit: [logoSize, logoSize] });
      } catch {}
    }

    const addrParts = [];
    if (companyProfile.address_line1) addrParts.push(companyProfile.address_line1);
    if (companyProfile.address_line2) addrParts.push(companyProfile.address_line2);

    const cityStatePin = [companyProfile.city, companyProfile.state, companyProfile.pincode]
      .filter(Boolean)
      .join(", ");
    if (cityStatePin) addrParts.push(cityStatePin);

    const lines = [];

    // ✅ Bigger company name
    if (companyProfile.name)
      lines.push({ text: companyProfile.name, font: "Helvetica-Bold", size: 20 });

    if (addrParts.length) lines.push({ text: addrParts.join(", "), font: "Helvetica", size: 9 });

    const contactParts = [];
    if (companyProfile.phone_primary) contactParts.push(`Phone: ${companyProfile.phone_primary}`);
    if (companyProfile.email) contactParts.push(`Email: ${companyProfile.email}`);
    if (contactParts.length)
      lines.push({ text: contactParts.join(" | "), font: "Helvetica", size: 9 });

    if (companyProfile.gstin)
      lines.push({ text: `GSTIN: ${companyProfile.gstin}`, font: "Helvetica", size: 9 });

    let yCursor = startY;
    for (const ln of lines) {
      doc.font(ln.font).fontSize(ln.size).fillColor("#000");
      doc.text(safeText(ln.text), textX, yCursor, { width: textWidth, align: "left" });
      const h = doc.heightOfString(safeText(ln.text), { width: textWidth });
      yCursor += h + 2;
    }

    const headerBottom = Math.max(startY + (logoBuf ? logoSize : 0), yCursor) + 12;
    doc.y = headerBottom;

    drawHR();
    doc.moveDown(0.35);
  }

  /* ---------- Title ---------- */
  doc.font("Helvetica-Bold").fontSize(isPurchaseOrder ? 16 : 14).fillColor("#000");
  const titleBoxW = Math.floor(contentWidth * 0.72);
  const titleX = pageLeft + Math.floor((contentWidth - titleBoxW) / 2);
  doc.text(safeText(pdfTitle), titleX, doc.y, { width: titleBoxW, align: "center" });
  doc.moveDown(0.5);

  /* ---------- TOP: Order No (left) + Date (right) ---------- */
  const topY = doc.y;
  const leftTopW = Math.floor(contentWidth * 0.6);
  const rightTopX = pageLeft + Math.floor(contentWidth * 0.65);
  const rightTopW = pageRight - rightTopX;

  const orderNoText = safeText(order?.order_no || order?.id);

  doc.font("Helvetica-Bold").fontSize(13).fillColor("#000");
  doc.text(`Order No: ${orderNoText}`, pageLeft, topY, { width: leftTopW, align: "left" });

  doc.fillColor("#000");
  doc.font(L.boldOrderDate ? "Helvetica-Bold" : "Helvetica").fontSize(9);
  doc.text(`Order Date: ${safeText(orderDate)}`, rightTopX, topY + 1, {
    width: rightTopW,
    align: "right",
  });

  if (showPrintDate) {
    doc.font("Helvetica").fontSize(9);
    doc.text(`Print Date: ${safeText(dateStr)}`, rightTopX, doc.y + 2, {
      width: rightTopW,
      align: "right",
    });
  }

  const leftH = doc.heightOfString(`Order No: ${orderNoText}`, { width: leftTopW });
  const rightText = showPrintDate
    ? `Order Date: ${safeText(orderDate)}\nPrint Date: ${safeText(dateStr)}`
    : `Order Date: ${safeText(orderDate)}`;
  const rightH = doc.heightOfString(rightText, { width: rightTopW });

  doc.y = topY + Math.max(leftH, rightH) + 8;

  drawHR();
  doc.moveDown(0.35);

  /* ---------- To (Supplier) ---------- */
  if (toParty && toParty.name) {
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#000");
    doc.text("To:", pageLeft, doc.y);

    const boxTop = doc.y + 2;

    const buildTransportText = () => {
      const t1 = order?.transport || null;
      const t2 = order?.transport2 || null;

      const fmtOne = (t, label) => {
        if (!t) return null;

        const name = safeText(t.name || "");
        const city = safeText(t.city || "");
        const phone = safeText(t.phone || "");
        const contact = safeText(t.contact_person || "");
        const email = safeText(t.email || "");

        const addrParts = [];
        if (t.address) addrParts.push(safeText(t.address));
        const csp = [t.city, t.state, t.pincode].filter(Boolean).join(", ");
        if (csp) addrParts.push(safeText(csp));
        const addressLine = addrParts.join(", ");

        const remarks = safeText(t.remarks || "");

        if (!name && !city && !phone && !addressLine && !remarks && !contact && !email) return null;

        const headParts = [];
        if (name) headParts.push(name);
        if (city) headParts.push(city);
        const head = headParts.join(" - ") || "-";

        const out = [];
        out.push(`${label}: ${head}`);
        if (contact) out.push(`Contact: ${contact}`);
        if (phone) out.push(`Phone: ${phone}`);
        if (email) out.push(`Email: ${email}`);
        if (addressLine) out.push(`Address: ${addressLine}`);
        if (remarks) out.push(`Remarks: ${remarks}`);

        return out.join("\n");
      };

      const blocks = [];
      const one1 = fmtOne(t1, "Transport");
      const one2 = fmtOne(t2, "Transport 2");
      if (one1) blocks.push(one1);
      if (one2) blocks.push(one2);
      return blocks.join("\n\n");
    };

    if (L.supplierAddressSecondColumn) {
      const colGap = 12;
      const colW = Math.floor((contentWidth - colGap) / 2);
      const col1X = pageLeft;
      const col2X = pageLeft + colW + colGap;

      const name = safeText(toParty.name);
      const addr = safeText(toParty.address || "");
      const phoneLine = toParty.phone ? `Phone: ${safeText(toParty.phone)}` : "";
      const emailLine = toParty.email ? `Email: ${safeText(toParty.email)}` : "";

      const transportText = safeText(buildTransportText());

      // measure left height
      doc.font(L.boldSupplierName ? "Helvetica-Bold" : "Helvetica").fontSize(10);
      const hName = doc.heightOfString(name, { width: colW });

      doc.font("Helvetica").fontSize(9);
      const hAddr = addr ? doc.heightOfString(addr, { width: colW }) : 0;

      const metaLines = [phoneLine, emailLine].filter(Boolean).join("\n");
      const hMeta = metaLines ? doc.heightOfString(metaLines, { width: colW }) : 0;

      const leftBlockH = hName + (addr ? 2 + hAddr : 0) + (metaLines ? 2 + hMeta : 0);

      // measure right height
      doc.font("Helvetica-Bold").fontSize(9);
      const transportTitle = transportText ? "Transport Details" : "";
      const hTRTitle = transportTitle ? doc.heightOfString(transportTitle, { width: colW }) : 0;

      doc.font("Helvetica").fontSize(9);
      const hTRBody = transportText ? doc.heightOfString(transportText, { width: colW }) : 0;

      const rightBlockH = (transportTitle ? hTRTitle + 2 : 0) + (transportText ? hTRBody : 0);

      // draw LEFT
      doc.font(L.boldSupplierName ? "Helvetica-Bold" : "Helvetica").fontSize(10).fillColor("#000");
      doc.text(name, col1X, boxTop, { width: colW });

      doc.font("Helvetica").fontSize(9).fillColor("#000");
      let yL = boxTop + hName + 2;

      if (addr) {
        doc.text(addr, col1X, yL, { width: colW });
        yL = doc.y + 2;
      }
      if (phoneLine) {
        doc.text(phoneLine, col1X, yL, { width: colW });
        yL = doc.y;
      }
      if (emailLine) {
        doc.text(emailLine, col1X, yL, { width: colW });
        yL = doc.y;
      }

      // draw RIGHT
      if (transportText) {
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#000");
        doc.text("Transport Details", col2X, boxTop, { width: colW });

        doc.font("Helvetica").fontSize(9).fillColor("#000");
        doc.text(transportText, col2X, doc.y + 2, { width: colW });
      }

      doc.y = boxTop + Math.max(leftBlockH, rightBlockH) + 8;
    } else {
      doc.font(L.boldSupplierName ? "Helvetica-Bold" : "Helvetica").fontSize(10).fillColor("#000");
      doc.text(safeText(toParty.name), pageLeft, boxTop);

      const subLines = [];
      if (toParty.address) subLines.push(safeText(toParty.address));
      if (toParty.phone) subLines.push(`Phone: ${safeText(toParty.phone)}`);
      if (toParty.email) subLines.push(`Email: ${safeText(toParty.email)}`);

      doc.font("Helvetica").fontSize(9).fillColor("#000");
      for (const ln of subLines) {
        doc.text(ln, pageLeft, doc.y, { width: Math.floor(contentWidth * 0.72) });
      }
    }
  }

  doc.moveDown(0.25);
  drawHR();
  doc.moveDown(0.4);

  /* ---------- Summary ---------- */
  const totalOrdered = (items || []).reduce((sum, it) => sum + (Number(it.total_order_qty) || 0), 0);

  const boxY = doc.y;
  const boxH = L.summaryTotalOnly ? 28 : showReceivedPending ? 58 : 40;

  doc.save();
  doc.rect(pageLeft, boxY, contentWidth, boxH).fill("#f6f8fb");
  doc.restore();

  doc.fillColor("#000");
  if (!L.summaryTotalOnly) {
    doc.font("Helvetica-Bold").fontSize(10);
    doc.text("Summary", pageLeft + 10, boxY + 8);
  }

  doc.font("Helvetica").fontSize(9);
  doc.text(`Total Ordered: ${totalOrdered}`, pageLeft + 10, boxY + (L.summaryTotalOnly ? 10 : 26), {
    width: contentWidth - 20,
  });

  if (!L.summaryTotalOnly && showReceivedPending) {
    const totalReceived = (items || []).reduce((sum, it) => sum + (Number(it.received_qty) || 0), 0);
    const totalPending = Math.max(totalOrdered - totalReceived, 0);
    const completion = totalOrdered > 0 ? Math.round((totalReceived / totalOrdered) * 100) : 0;

    doc.text(`Completion: ${completion}%`, pageLeft + contentWidth / 2, boxY + 26, {
      width: contentWidth / 2 - 10,
      align: "right",
    });

    doc.text(`Total Received: ${totalReceived}`, pageLeft + 10, boxY + 40, {
      width: contentWidth / 2 - 10,
    });

    doc.text(`Total Pending: ${totalPending}`, pageLeft + contentWidth / 2, boxY + 40, {
      width: contentWidth / 2 - 10,
      align: "right",
    });
  }

  doc.y = boxY + boxH + 10;

  /* ---------- Table ---------- */
  const hideSubject = L.hideSubject === true;

  let W, X;

  if (showReceivedPending) {
    if (hideSubject) {
      W = { sr: 32, title: 0, ord: 85, rec: 85, pend: 85 };
      W.title = contentWidth - (W.sr + W.ord + W.rec + W.pend);
      if (W.title < 200) W.title = Math.max(200, W.title);
      X = {
        sr: pageLeft,
        title: pageLeft + W.sr,
        ord: pageLeft + W.sr + W.title,
        rec: pageLeft + W.sr + W.title + W.ord,
        pend: pageLeft + W.sr + W.title + W.ord + W.rec,
      };
    } else {
      W = { sr: 32, title: 0, subject: 70, ord: 85, rec: 85, pend: 85 };
      W.title = contentWidth - (W.sr + W.subject + W.ord + W.rec + W.pend);
      if (W.title < 140) {
        const need = 140 - W.title;
        W.subject = Math.max(60, W.subject - need);
        W.title = contentWidth - (W.sr + W.subject + W.ord + W.rec + W.pend);
      }
      X = {
        sr: pageLeft,
        title: pageLeft + W.sr,
        subject: pageLeft + W.sr + W.title,
        ord: pageLeft + W.sr + W.title + W.subject,
        rec: pageLeft + W.sr + W.title + W.subject + W.ord,
        pend: pageLeft + W.sr + W.title + W.subject + W.ord + W.rec,
      };
    }
  } else {
    if (hideSubject) {
      W = { sr: 32, title: 0, ord: 90 };
      W.title = contentWidth - (W.sr + W.ord);
      X = { sr: pageLeft, title: pageLeft + W.sr, ord: pageLeft + W.sr + W.title };
    } else {
      W = { sr: 32, title: 0, subject: 90, ord: 90 };
      W.title = contentWidth - (W.sr + W.subject + W.ord);
      if (W.title < 160) {
        const need = 160 - W.title;
        W.subject = Math.max(70, W.subject - need);
        W.title = contentWidth - (W.sr + W.subject + W.ord);
      }
      X = {
        sr: pageLeft,
        title: pageLeft + W.sr,
        subject: pageLeft + W.sr + W.title,
        ord: pageLeft + W.sr + W.title + W.subject,
      };
    }
  }

  // ✅ vertical lines X list
  const gridXs = (() => {
    const arr = [pageLeft];
    arr.push(X.title);
    if (!hideSubject && X.subject != null) arr.push(X.subject);
    arr.push(X.ord);
    if (showReceivedPending) {
      arr.push(X.rec);
      arr.push(X.pend);
    }
    arr.push(pageRight);
    return Array.from(new Set(arr)).sort((a, b) => a - b);
  })();

  // helpers
  const getPublisherName = (it) =>
    safeText(it?.book?.publisher?.name || it?.book?.publisher_name || "Other / Unknown");
  const getBookTitle = (it) => safeText(it?.book?.title || `Book #${it?.book_id}`);

  const printPublisherHeader = (publisherName) => {
    const y = doc.y;
    const h = 18;

    doc.save();
    doc.rect(pageLeft, y, contentWidth, h).fill("#e9ecef");
    doc.restore();

    doc.save();
    doc.lineWidth(0.7);
    doc.rect(pageLeft, y, contentWidth, h).stroke();
    doc.restore();

    doc.fillColor("#000").font("Helvetica-Bold").fontSize(10);
    doc.text(`Publisher: ${publisherName}`, pageLeft + 6, y + 4, {
      width: contentWidth - 12,
      align: "left",
    });

    doc.y = y + h; // ✅ no extra gap here (tight)
  };

  const printTableHeader = () => {
    const y = doc.y;
    const headerH = 20;

    doc.save();
    doc.rect(pageLeft, y, contentWidth, headerH).fill("#f2f2f2");
    doc.restore();

    doc.fillColor("#000").font("Helvetica-Bold").fontSize(10);

    const padX = L.rowPadX;
    const textY = y + 5;

    doc.text("Sr", X.sr + padX, textY, { width: W.sr - padX * 2 });
    doc.text("Book Title", X.title + padX, textY, { width: W.title - padX * 2 });

    if (!hideSubject && X.subject != null) {
      doc.text("Subject", X.subject + padX, textY, { width: W.subject - padX * 2 });
    }

    doc.text("Ordered", X.ord, textY, { width: W.ord, align: "center", lineBreak: false });

    if (showReceivedPending) {
      doc.text("Received", X.rec, textY, { width: W.rec, align: "center", lineBreak: false });
      doc.text("Pending", X.pend, textY, { width: W.pend, align: "center", lineBreak: false });
    }

    drawTableGrid(y, y + headerH, gridXs, pageLeft, pageRight);

    doc.y = y + headerH; // ✅ NO GAP after header
  };

  const rowHeight = (cells, fontSize = 9) => {
    doc.font("Helvetica").fontSize(fontSize);
    const h1 = doc.heightOfString(cells.title, { width: Math.max(10, W.title - 8) });
    if (hideSubject) return Math.ceil(Math.max(h1, fontSize + 2)) + 8;
    const h2 = doc.heightOfString(cells.subject, { width: Math.max(10, W.subject - 8) });
    return Math.ceil(Math.max(h1, h2, fontSize + 2)) + 8;
  };

  const ensureSpaceWithHeaderAndGroup = (neededHeight, currentPublisher) => {
    const bottom = doc.page.height - doc.page.margins.bottom;
    if (doc.y + neededHeight > bottom) {
      doc.addPage();
      printTableHeader();
      if (currentPublisher) {
        doc.y += 6; // little breathing before publisher box
        printPublisherHeader(currentPublisher);
      }
      return true;
    }
    return false;
  };

  // Print header
  printTableHeader();

  if (!items || !items.length) {
    doc.font("Helvetica").fontSize(10).fillColor("#000");
    doc.text("No items found in this order.", pageLeft, doc.y + 8);
  } else {
    const sortedItems = [...items].sort((a, b) => {
      const pa = getPublisherName(a).toLowerCase();
      const pb = getPublisherName(b).toLowerCase();
      const pc = pa.localeCompare(pb, "en", { sensitivity: "base" });
      if (pc !== 0) return pc;

      const ta = getBookTitle(a).toLowerCase();
      const tb = getBookTitle(b).toLowerCase();
      return ta.localeCompare(tb, "en", { sensitivity: "base" });
    });

    let currentPublisher = null;
    let sr = 1;

    for (const it of sortedItems) {
      const publisherName = getPublisherName(it);

      if (publisherName !== currentPublisher) {
        currentPublisher = publisherName;
        if (L.resetSrPerPublisher) sr = 1;

        ensureSpaceWithHeaderAndGroup(28, null);

        // small gap after header before first group box
        // doc.y += 6;
        printPublisherHeader(currentPublisher);

        // small gap after publisher box before first row
        // doc.y += 6;
      }

      const orderedQty = Number(it.total_order_qty) || 0;
      const receivedQty = Number(it.received_qty) || 0;
      const pendingQty = Math.max(orderedQty - receivedQty, 0);

      const cells = {
        title: getBookTitle(it),
        subject: safeText(it?.book?.subject || "-"),
      };

      const rh = rowHeight(cells, 9);
      ensureSpaceWithHeaderAndGroup(rh, currentPublisher);

      const rowTop = doc.y;
      const rowBottom = rowTop + rh;

      // alternate background
      const isAlt = sr % 2 === 0;
      if (isAlt) {
        doc.save();
        doc.rect(pageLeft, rowTop, contentWidth, rh).fill("#fbfcfe");
        doc.restore();
      }

      const padX = L.rowPadX;
      const textY = rowTop + L.rowPadY;

      doc.fillColor("#000");
      doc.font("Helvetica").fontSize(9);
      doc.text(String(sr), X.sr + padX, textY, { width: W.sr - padX * 2 });
      doc.text(cells.title, X.title + padX, textY, { width: W.title - padX * 2 });

      if (!hideSubject && X.subject != null) {
        doc.text(cells.subject, X.subject + padX, textY, { width: W.subject - padX * 2 });
      }

      doc.font("Helvetica-Bold").fontSize(10);
      doc.text(String(orderedQty), X.ord, textY - 1, { width: W.ord, align: "center" });

      if (showReceivedPending) {
        doc.text(String(receivedQty), X.rec, textY - 1, { width: W.rec, align: "center" });
        doc.text(String(pendingQty), X.pend, textY - 1, { width: W.pend, align: "center" });
      }

      // ✅ SINGLE grid draw; NO extra bottom line
      drawTableGrid(rowTop, rowBottom, gridXs, pageLeft, pageRight);

      // ✅ IMPORTANT: next row starts EXACTLY at rowBottom (NO SPACE)
      doc.y = rowBottom;

      sr++;
    }
  }

  /* ---------- Notes ---------- */
  const note1FromOrder = safeText(order?.notes || "");
  const note2FromOrder = safeText(order?.notes_2 || "");

  const note1 = safeText(notes?.note1 ?? notes?.note_1 ?? note1FromOrder);
  const note2 = safeText(notes?.note2 ?? notes?.note_2 ?? note2FromOrder);

  if (note1 || note2) {
    const combined =
      (note1 ? `Note 1: ${note1}` : "") +
      (note1 && note2 ? "\n\n" : "") +
      (note2 ? `Note 2: ${note2}` : "");

    const noteH = Math.max(38, doc.heightOfString(combined, { width: contentWidth - 20 }) + 22);

    const bottom = doc.page.height - doc.page.margins.bottom;
    if (doc.y + noteH + 10 > bottom) doc.addPage();

    doc.y += 10;

    const y = doc.y;
    doc.save();
    doc.rect(pageLeft, y, contentWidth, noteH).fill("#fff3cd");
    doc.restore();

    doc.save();
    doc.lineWidth(0.7);
    doc.rect(pageLeft, y, contentWidth, noteH).stroke();
    doc.restore();

    doc.font("Helvetica-Bold").fontSize(10).fillColor("#000");
    doc.text("Notes", pageLeft + 10, y + 8);

    doc.font("Helvetica").fontSize(9).fillColor("#000");
    doc.text(combined, pageLeft + 10, y + 22, {
      width: contentWidth - 20,
      align: "left",
    });

    doc.y = y + noteH + 2;
  }
}



/* ============================================================
 * PDF builder -> Buffer (single order)
 * ============================================================ */
function buildSchoolOrderPdfBuffer({
  order,
  companyProfile,
  items,
  pdfTitle,
  toParty,
  dateStr,
  orderDate,
  isPurchaseOrder = false,
  showPrintDate = false,
  showReceivedPending = true,
  notes = null,
  layout = {},
}) {
  return new Promise(async (resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      await renderSchoolOrderToDoc(doc, {
        order,
        companyProfile,
        items,
        pdfTitle,
        toParty,
        dateStr,
        orderDate,
        isPurchaseOrder,
        showPrintDate,
        showReceivedPending,
        notes,
        layout,
      });
      doc.end();
    } catch (e) {
      try {
        doc.end();
      } catch {}
      reject(e);
    }
  });
}

/* ============================================
 * ✅ NEW: GET /api/school-orders/pdf/all
 * One click -> download ALL orders in ONE PDF (each order starts on a new page)
 * ============================================ */
exports.printAllOrdersPdf = async (request, reply) => {
  try {
    const {
      academic_session,
      school_id,
      supplier_id,
      status,
      order_type,
      view = "SUPPLIER",
      inline = "1",
    } = request.query || {};

    const where = {};
    if (academic_session) where.academic_session = String(academic_session).trim();
    if (school_id) where.school_id = Number(school_id);
    if (supplier_id) where.supplier_id = Number(supplier_id);
    if (status) where.status = String(status).trim();
    if (order_type) where.order_type = String(order_type).trim();

    const orders = await SchoolOrder.findAll({
      where,
      include: [
        { model: School, as: "school", attributes: ["id", "name", "city"] },
        { model: Supplier, as: "supplier" },
        {
          model: SchoolOrderItem,
          as: "items",
          include: [
            {
              model: Book,
              as: "book",
              attributes: ["id", "title", "class_name", "subject", "code", "isbn", "publisher_id"],
              include: [{ model: Publisher, as: "publisher", attributes: ["id", "name"] }],
            },
          ],
        },
        { model: Transport, as: "transport" },
        ...(SchoolOrder.associations?.transport2 ? [{ model: Transport, as: "transport2" }] : []),
      ],
      order: [
        [{ model: School, as: "school" }, "name", "ASC"],
        [{ model: Supplier, as: "supplier" }, "name", "ASC"],
        ["order_date", "DESC"],
        ["createdAt", "DESC"],
        [{ model: SchoolOrderItem, as: "items" }, "id", "ASC"],
      ],
    });

    const companyProfile = await CompanyProfile.findOne({
      where: { is_active: true },
      order: [
        ["is_default", "DESC"],
        ["id", "ASC"],
      ],
    });

    const today = new Date();
    const dateStr = today.toLocaleDateString("en-IN");

    const viewMode = String(view || "SUPPLIER").toUpperCase();
    const showReceivedPending = viewMode === "INTERNAL";
    const pdfTitle = showReceivedPending ? "SCHOOL ORDER" : "PURCHASE ORDER";

    // Client requested layout:
    const layout = {
      hideSubject: true,
      summaryTotalOnly: true,
      supplierAddressSecondColumn: true,
      boldSupplierName: true,
      boldOrderDate: true,
    };

    // Build one PDF
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));

    const bufPromise = new Promise((resolve, reject) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });

    if (!orders.length) {
      doc.font("Helvetica-Bold").fontSize(16).text("No orders found for selected filters.");
      doc.end();
      const pdfBuffer = await bufPromise;

      const fname = `all-school-orders-${dateStr.replace(/[^\d]+/g, "-")}.pdf`;
      reply
        .header("Content-Type", "application/pdf")
        .header(
          "Content-Disposition",
          `${String(inline) === "1" ? "inline" : "attachment"}; filename="${fname}"`
        )
        .send(pdfBuffer);
      return reply;
    }

    for (let i = 0; i < orders.length; i++) {
      const o = orders[i];
      const orderForPdf = o.toJSON();

      orderForPdf.transport = o.transport?.toJSON?.() || o.transport || null;
      if (o.transport2) orderForPdf.transport2 = o.transport2?.toJSON?.() || o.transport2 || null;

      const orderDate = o.order_date ? new Date(o.order_date).toLocaleDateString("en-IN") : "-";

      const supplier = o.supplier;
      const supplierName = supplier?.name || "Supplier";
      const supplierAddress =
        supplier?.address || supplier?.address_line1 || supplier?.full_address || "";
      const supplierPhone = supplier?.phone || supplier?.phone_primary || "";
      const supplierEmail = supplier?.email || "";

      const toParty = {
        name: supplierName,
        address: supplierAddress,
        phone: supplierPhone,
        email: supplierEmail,
      };

      // per-order notes: support order notes, else company profile defaults (optional)
      const pickStr = (v) => String(v ?? "").trim();
      const note1 =
        pickStr(orderForPdf.note_1) ||
        pickStr(orderForPdf.notes_1) ||
        pickStr(orderForPdf.note1) ||
        pickStr(orderForPdf.notes) ||
        "";
      const note2 =
        pickStr(orderForPdf.note_2) ||
        pickStr(orderForPdf.notes_2) ||
        pickStr(orderForPdf.note2) ||
        pickStr(orderForPdf.notes2) ||
        "";

      const defaultNote1 =
        pickStr(companyProfile?.note_1) ||
        pickStr(companyProfile?.notes_1) ||
        pickStr(companyProfile?.note1) ||
        "";
      const defaultNote2 =
        pickStr(companyProfile?.note_2) ||
        pickStr(companyProfile?.notes_2) ||
        pickStr(companyProfile?.note2) ||
        "";

      const notes = {
        note1: note1 || defaultNote1,
        note2: note2 || defaultNote2,
      };

      if (i > 0) doc.addPage();

      await renderSchoolOrderToDoc(doc, {
        order: orderForPdf,
        companyProfile,
        items: o.items || [],
        pdfTitle,
        toParty,
        dateStr,
        orderDate,
        isPurchaseOrder: !showReceivedPending,
        showPrintDate: false,
        showReceivedPending,
        notes,
        layout,
      });
    }

    doc.end();
    const pdfBuffer = await bufPromise;

    const fname = `all-school-orders-${dateStr.replace(/[^\d]+/g, "-")}.pdf`;

    reply
      .header("Content-Type", "application/pdf")
      .header(
        "Content-Disposition",
        `${String(inline) === "1" ? "inline" : "attachment"}; filename="${fname}"`
      )
      .send(pdfBuffer);

    return reply;
  } catch (err) {
    request.log.error({ err }, "Error in printAllOrdersPdf");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to generate bulk orders PDF",
    });
  }
};

/* ============================================
 * ✅ NEW: GET /api/school-orders/:orderId/email-preview
 * ============================================ */
exports.getOrderEmailPreview = async (request, reply) => {
  const { orderId } = request.params;

  try {
    const order = await SchoolOrder.findOne({
      where: { id: orderId },
      include: [{ model: School, as: "school" }, { model: Supplier, as: "supplier" }],
    });

    if (!order) return reply.code(404).send({ message: "School order not found." });

    const supplier = order.supplier;
    const supplierEmail = supplier?.email ? String(supplier.email).trim() : "";
    const supplierName = supplier?.name || "Supplier";

    const companyProfile = await CompanyProfile.findOne({
      where: { is_active: true },
      order: [
        ["is_default", "DESC"],
        ["id", "ASC"],
      ],
    });

    const cp = companyProfile ? companyProfile.toJSON?.() || companyProfile : null;
    const cpName = cp?.name || "Sumeet Book Store";
    const cpEmail =
      cp?.email ||
      process.env.ORDER_SUPPORT_EMAIL ||
      process.env.SMTP_FROM ||
      process.env.SMTP_USER ||
      "";

    const orderDate = order.order_date ? new Date(order.order_date).toLocaleDateString("en-IN") : "-";

    const subject = `Purchase Order – Order No ${order.order_no || order.id} – ${supplierName}`;
    const ccDefault = process.env.ORDER_EMAIL_CC || process.env.SMTP_USER || "";

    const html = `
      <p>Dear ${supplierName},</p>
      <p>Please find the attached <strong>Purchase Order PDF</strong>.</p>
      <div><strong>Order No:</strong> ${order.order_no || order.id}</div>
      <div><strong>Order Date:</strong> ${orderDate}</div>
      <p style="margin-top:16px;">
        Regards,<br/>
        <strong>${cpName}</strong><br/>
        ${cpEmail ? `Email: ${cpEmail}<br/>` : ""}
      </p>
    `;

    return reply.code(200).send({
      order_id: order.id,
      order_no: order.order_no || order.id,
      to: supplierEmail,
      cc: ccDefault,
      subject,
      html,
      replyTo: cpEmail || null,

      email_sent_count: order.email_sent_count ?? 0,
      last_email_sent_at: order.last_email_sent_at ?? null,
      last_email_to: order.last_email_to ?? null,
      last_email_cc: order.last_email_cc ?? null,
      last_email_subject: order.last_email_subject ?? null,
    });
  } catch (err) {
    request.log.error({ err }, "Error in getOrderEmailPreview");
    return reply.code(500).send({ message: err.message || "Failed to build email preview." });
  }
};

/* ============================================
 * ✅ NEW: GET /api/school-orders/:orderId/email-logs?limit=20
 * ============================================ */
exports.getOrderEmailLogs = async (request, reply) => {
  const { orderId } = request.params;
  const limit = Math.min(Number(request.query?.limit || 20) || 20, 50);

  try {
    const Log = getEmailLogModel();
    if (!Log) return reply.code(200).send({ data: [] });

    const rows = await Log.findAll({
      where: { school_order_id: Number(orderId) },
      order: [["sent_at", "DESC"]],
      limit,
    });

    return reply.code(200).send({ data: rows });
  } catch (err) {
    request.log.error({ err }, "Error in getOrderEmailLogs");
    return reply.code(500).send({ message: err.message || "Failed to load email logs." });
  }
};

/* ============================================
 * POST /api/school-orders/:orderId/send-email
 * ✅ UPDATED: accepts editable to/cc/subject/html from modal
 * body: { to, cc, subject, html }
 * ============================================ */
exports.sendOrderEmailForOrder = async (request, reply) => {
  const { orderId } = request.params;

  let { to, cc, subject, html } = request.body || {};
  to = normalizeEmailList(to);
  cc = normalizeEmailList(cc);

  try {
    const order = await SchoolOrder.findOne({
      where: { id: orderId },
      include: [
        { model: School, as: "school" },
        { model: Supplier, as: "supplier" },
        {
          model: SchoolOrderItem,
          as: "items",
          include: [
            {
              model: Book,
              as: "book",
              attributes: ["id", "title", "class_name", "subject", "code", "isbn", "publisher_id"],
              include: [{ model: Publisher, as: "publisher", attributes: ["id", "name"] }],
            },
          ],
        },
        { model: Transport, as: "transport" },
        ...(SchoolOrder.associations?.transport2 ? [{ model: Transport, as: "transport2" }] : []),
      ],
    });

    if (!order) return reply.code(404).send({ message: "School order not found." });

    const supplier = order.supplier;
    if (!supplier) {
      return reply.code(400).send({
        message: "Supplier not linked with this order. Please set school_orders.supplier_id.",
      });
    }

    // default TO if empty
    if (!to) to = supplier.email ? String(supplier.email).trim() : "";
    if (!to)
      return reply.code(400).send({ message: `Supplier email not set for "${supplier.name}".` });

    if (!validateEmailList(to)) return reply.code(400).send({ message: "Invalid To email(s)." });
    if (cc && !validateEmailList(cc))
      return reply.code(400).send({ message: "Invalid CC email(s)." });

    const today = new Date();
    const todayStr = today.toLocaleDateString("en-IN");
    const orderDate = order.order_date ? new Date(order.order_date).toLocaleDateString("en-IN") : "-";

    const companyProfile = await CompanyProfile.findOne({
      where: { is_active: true },
      order: [
        ["is_default", "DESC"],
        ["id", "ASC"],
      ],
    });

    const supplierName = supplier.name;

    const cp = companyProfile ? companyProfile.toJSON?.() || companyProfile : null;
    const cpName = cp?.name || "Sumeet Book Store";
    const cpPhone = cp?.phone_primary || "";
    const cpEmail =
      cp?.email ||
      process.env.ORDER_SUPPORT_EMAIL ||
      process.env.SMTP_FROM ||
      process.env.SMTP_USER ||
      "";

    const cpGstin = cp?.gstin || "";
    const cpAddr = [
      cp?.address_line1,
      cp?.address_line2,
      [cp?.city, cp?.state, cp?.pincode].filter(Boolean).join(", "),
    ]
      .filter(Boolean)
      .join(", ");

    if (!subject || !String(subject).trim()) {
      subject = `Purchase Order – Order No ${order.order_no || order.id} – ${supplierName}`;
    }
    subject = String(subject).trim();

    if (!html || !String(html).trim()) {
      html = `
        <p>Dear ${supplierName},</p>
        <p>Please find the attached <strong>Purchase Order PDF</strong>.</p>
        <div><strong>Order No:</strong> ${order.order_no || order.id}</div>
        <div><strong>Order Date:</strong> ${orderDate}</div>
        <p style="margin-top:16px;">
          Regards,<br/>
          <strong>${cpName}</strong><br/>
          ${cpAddr ? `${cpAddr}<br/>` : ""}
          ${cpPhone ? `Phone: ${cpPhone}<br/>` : ""}
          ${cpEmail ? `Email: ${cpEmail}<br/>` : ""}
          ${cpGstin ? `GSTIN: ${cpGstin}<br/>` : ""}
        </p>
      `;
    }

    const safeOrderNo = String(order.order_no || `order-${order.id}`).replace(/[^\w\-]+/g, "_");

    const supplierPhone = supplier.phone || supplier.phone_primary || "";
    const supplierAddress = supplier.address || supplier.address_line1 || supplier.full_address || "";

    const toParty = {
      name: supplierName,
      address: supplierAddress,
      phone: supplierPhone,
      email: to, // use actual "to" in pdf header
    };

    const orderForPdf = order.toJSON();
    orderForPdf.transport = order.transport ? order.transport.toJSON?.() || order.transport : null;
    // ✅ FIX: pass transport2 also so PDF right-side shows it
    if (order.transport2) {
      orderForPdf.transport2 = order.transport2?.toJSON?.() || order.transport2;
    }

    // ✅ Supplier PDF should NOT show received/pending
    const pdfBuffer = await buildSchoolOrderPdfBuffer({
      order: orderForPdf,
      companyProfile,
      items: order.items || [],
      pdfTitle: "PURCHASE ORDER",
      toParty,
      dateStr: todayStr,
      orderDate,
      isPurchaseOrder: true,
      showPrintDate: false,
      showReceivedPending: false,

      // client layout
      layout: {
        hideSubject: true,
        summaryTotalOnly: true,
        supplierAddressSecondColumn: true,
        boldSupplierName: true,
        boldOrderDate: true,
      },
    });

    const filename = `school-order-${safeOrderNo}-supplier-${order.supplier_id}.pdf`;

    const info = await sendMail({
      to,
      cc: cc || undefined,
      subject,
      html,
      replyTo: cpEmail || undefined,
      attachments: [{ filename, content: pdfBuffer, contentType: "application/pdf" }],
    });

    // ✅ update order counters + last info (only if columns exist)
    try {
      order.status = "sent";
      if ("email_sent_at" in order) order.email_sent_at = new Date();

      if ("email_sent_count" in order)
        order.email_sent_count = (Number(order.email_sent_count) || 0) + 1;
      if ("last_email_sent_at" in order) order.last_email_sent_at = new Date();
      if ("last_email_to" in order) order.last_email_to = to;
      if ("last_email_cc" in order) order.last_email_cc = cc || null;
      if ("last_email_subject" in order) order.last_email_subject = subject;

      await order.save();
    } catch {}

    // ✅ write email log (SENT)
    try {
      const Log = getEmailLogModel();
      if (Log) {
        await Log.create({
          school_order_id: order.id,
          sent_at: new Date(),
          to_email: to,
          cc_email: cc || null,
          subject: subject.slice(0, 255),
          status: "SENT",
          message_id: info?.messageId || null,
          sent_by_user_id: request.user?.id || null,
        });
      }
    } catch {}

    return reply.code(200).send({
      message: "Supplier purchase order email (with PDF) sent successfully.",
      order_id: order.id,
      supplier_id: order.supplier_id,
      to,
      cc: cc || null,
      order_no: order.order_no || order.id,
      message_id: info?.messageId || null,
      email_sent_count: order.email_sent_count ?? undefined,
    });
  } catch (err) {
    // ✅ write email log (FAILED)
    try {
      const Log = getEmailLogModel();
      if (Log) {
        await Log.create({
          school_order_id: Number(orderId),
          sent_at: new Date(),
          to_email: to || "",
          cc_email: cc || null,
          subject: String(subject || "Purchase Order").slice(0, 255),
          status: "FAILED",
          error: err?.message || String(err),
          sent_by_user_id: request.user?.id || null,
        });
      }
    } catch {}

    console.error("Error in sendOrderEmailForOrder:", err);
    return reply.code(500).send({
      error: "Error",
      message: err.message || "Failed to send supplier order email.",
    });
  }
};

/* ============================================
 * GET /api/school-orders/:orderId/pdf
 * ============================================ */
exports.printOrderPdf = async (request, reply) => {
  const { orderId } = request.params;

  try {
    const order = await SchoolOrder.findOne({
      where: { id: orderId },
      include: [
        { model: School, as: "school", attributes: ["id", "name", "city"] },
        { model: Supplier, as: "supplier" },
        {
          model: SchoolOrderItem,
          as: "items",
          include: [
            {
              model: Book,
              as: "book",
              attributes: ["id", "title", "class_name", "subject", "code", "isbn", "publisher_id"],
              include: [{ model: Publisher, as: "publisher", attributes: ["id", "name"] }],
            },
          ],
        },
        { model: Transport, as: "transport" },
        ...(SchoolOrder.associations?.transport2 ? [{ model: Transport, as: "transport2" }] : []),
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
      return reply.code(404).send({
        error: "NotFound",
        message: "School order not found",
      });
    }

    const items = order.items || [];

    const today = new Date();
    const dateStr = today.toLocaleDateString("en-IN");
    const orderDate = order.order_date ? new Date(order.order_date).toLocaleDateString("en-IN") : "-";

    const supplier = order.supplier;
    const supplierName = supplier?.name || "Supplier";
    const supplierAddress =
      supplier?.address || supplier?.address_line1 || supplier?.full_address || "";
    const supplierPhone = supplier?.phone || supplier?.phone_primary || "";
    const supplierEmail = supplier?.email || "";

    const toParty = {
      name: supplierName,
      address: supplierAddress,
      phone: supplierPhone,
      email: supplierEmail,
    };

    // Two Notes Support (fallback company profile defaults)
    const pickStr = (v) => String(v ?? "").trim();

    const note1 =
      pickStr(order.note_1) ||
      pickStr(order.notes_1) ||
      pickStr(order.note1) ||
      pickStr(order.notes) ||
      "";

    const note2 =
      pickStr(order.note_2) ||
      pickStr(order.notes_2) ||
      pickStr(order.note2) ||
      pickStr(order.notes2) ||
      "";

    const defaultNote1 =
      pickStr(companyProfile?.note_1) ||
      pickStr(companyProfile?.notes_1) ||
      pickStr(companyProfile?.note1) ||
      "";

    const defaultNote2 =
      pickStr(companyProfile?.note_2) ||
      pickStr(companyProfile?.notes_2) ||
      pickStr(companyProfile?.note2) ||
      "";

    const notesForPdf = {
      note1: note1 || defaultNote1,
      note2: note2 || defaultNote2,
    };

    // For PDF
    const orderForPdf = order.toJSON();
    orderForPdf.transport = order.transport?.toJSON?.() || order.transport || null;
    if (order.transport2)
      orderForPdf.transport2 = order.transport2?.toJSON?.() || order.transport2 || null;

    const safeOrderNo = String(order.order_no || `order-${order.id}`).replace(/[^\w\-]+/g, "_");

    // ✅ Supplier PDF should NOT show received/pending
    const pdfBuffer = await buildSchoolOrderPdfBuffer({
      order: orderForPdf,
      companyProfile,
      items,
      pdfTitle: "PURCHASE ORDER",
      toParty,
      dateStr,
      orderDate,
      isPurchaseOrder: true,
      showPrintDate: false,
      showReceivedPending: false,
      notes: notesForPdf,
      layout: {
        hideSubject: true,
        summaryTotalOnly: true,
        supplierAddressSecondColumn: true,
        boldSupplierName: true,
        boldOrderDate: true,
      },
    });

    reply
      .header("Content-Type", "application/pdf")
      .header(
        "Content-Disposition",
        `inline; filename="school-order-${safeOrderNo}-supplier-${order.supplier_id}.pdf"`
      )
      .send(pdfBuffer);

    return reply;
  } catch (err) {
    request.log.error({ err }, "Error in printOrderPdf");
    if (!reply.sent) {
      return reply.code(500).send({
        error: "InternalServerError",
        message: err.message || "Failed to generate supplier order PDF",
      });
    }
  }
};


/* ============================================================
 * ✅ NEW: Supplier + Order No Index PDF (2 columns only)
 * GET /api/school-orders/pdf/supplier-order-index
 * Query: academic_session, school_id, supplier_id, status, order_type, inline
 * ============================================================ */
exports.printSupplierOrderIndexPdf = async (request, reply) => {
  try {
    const {
      academic_session,
      school_id,
      supplier_id,
      status,
      order_type,
      inline = "1",
    } = request.query || {};

    const where = {};
    if (academic_session) where.academic_session = String(academic_session).trim();
    if (school_id) where.school_id = Number(school_id);
    if (supplier_id) where.supplier_id = Number(supplier_id);
    if (status) where.status = String(status).trim();
    if (order_type) where.order_type = String(order_type).trim();

    const orders = await SchoolOrder.findAll({
      where,
      include: [{ model: Supplier, as: "supplier", attributes: ["id", "name"] }],
      attributes: ["id", "order_no", "order_date", "supplier_id", "academic_session", "status"],
      order: [
        [{ model: Supplier, as: "supplier" }, "name", "ASC"],
        ["order_date", "DESC"],
        ["createdAt", "DESC"],
      ],
    });

    const companyProfile = await CompanyProfile.findOne({
      where: { is_active: true },
      order: [
        ["is_default", "DESC"],
        ["id", "ASC"],
      ],
    });

    const today = new Date();
    const dateStr = today.toLocaleDateString("en-IN");

    // ---- PDF helpers ----
    const safeText = (v) => String(v ?? "").trim();

    async function printCompanyHeader(doc) {
      const pageLeft = doc.page.margins.left;
      const pageRight = doc.page.width - doc.page.margins.right;
      const contentWidth = pageRight - pageLeft;

      const drawHR = () => {
        doc.save();
        doc.lineWidth(0.7);
        doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).stroke();
        doc.restore();
      };

      if (!companyProfile) return;

      const startY = doc.y;
      const logoSize = 52;
      const gap = 10;

      const logoRef =
        companyProfile.logo_url ||
        companyProfile.logo ||
        companyProfile.logo_path ||
        companyProfile.logo_image ||
        null;

      let logoBuf = null;
      try {
        logoBuf = await loadLogoBuffer(logoRef);
      } catch {
        logoBuf = null;
      }

      const logoX = pageLeft;
      const logoY = startY;
      const textX = logoBuf ? logoX + logoSize + gap : pageLeft;
      const textWidth = pageRight - textX;

      if (logoBuf) {
        try {
          doc.image(logoBuf, logoX, logoY, { fit: [logoSize, logoSize] });
        } catch {}
      }

      const addrParts = [];
      if (companyProfile.address_line1) addrParts.push(companyProfile.address_line1);
      if (companyProfile.address_line2) addrParts.push(companyProfile.address_line2);

      const cityStatePin = [companyProfile.city, companyProfile.state, companyProfile.pincode]
        .filter(Boolean)
        .join(", ");
      if (cityStatePin) addrParts.push(cityStatePin);

      const lines = [];
      if (companyProfile.name)
        lines.push({ text: companyProfile.name, font: "Helvetica-Bold", size: 16 });
      if (addrParts.length) lines.push({ text: addrParts.join(", "), font: "Helvetica", size: 9 });

      const contactParts = [];
      if (companyProfile.phone_primary) contactParts.push(`Phone: ${companyProfile.phone_primary}`);
      if (companyProfile.email) contactParts.push(`Email: ${companyProfile.email}`);
      if (contactParts.length)
        lines.push({ text: contactParts.join(" | "), font: "Helvetica", size: 9 });

      if (companyProfile.gstin)
        lines.push({ text: `GSTIN: ${companyProfile.gstin}`, font: "Helvetica", size: 9 });

      let yCursor = startY;
      for (const ln of lines) {
        doc.font(ln.font).fontSize(ln.size).fillColor("#000");
        doc.text(safeText(ln.text), textX, yCursor, { width: textWidth, align: "left" });
        const h = doc.heightOfString(safeText(ln.text), { width: textWidth });
        yCursor += h + 2;
      }

      const headerBottom = Math.max(startY + (logoBuf ? logoSize : 0), yCursor) + 12;
      doc.y = headerBottom;

      drawHR();
      doc.moveDown(0.35);
    }

    function ensureSpace(doc, neededHeight, headerFn) {
      const bottom = doc.page.height - doc.page.margins.bottom;
      if (doc.y + neededHeight > bottom) {
        doc.addPage();
        if (typeof headerFn === "function") headerFn();
        return true;
      }
      return false;
    }

    function printTitleBlock(doc) {
      const pageLeft = doc.page.margins.left;
      const pageRight = doc.page.width - doc.page.margins.right;
      const contentWidth = pageRight - pageLeft;

      doc.font("Helvetica-Bold").fontSize(15).fillColor("#000");
      doc.text("SUPPLIER ORDER NUMBER LIST", pageLeft, doc.y, {
        width: contentWidth,
        align: "center",
      });
      doc.moveDown(0.3);

      doc.font("Helvetica").fontSize(9).fillColor("#000");
      const filters = [
        academic_session ? `Session: ${safeText(academic_session)}` : null,
        school_id ? `School ID: ${safeText(school_id)}` : null,
        supplier_id ? `Supplier ID: ${safeText(supplier_id)}` : null,
        status ? `Status: ${safeText(status)}` : null,
        order_type ? `Type: ${safeText(order_type)}` : null,
        `Print Date: ${safeText(dateStr)}`,
      ].filter(Boolean);

      doc.text(filters.join("  |  "), pageLeft, doc.y, { width: contentWidth, align: "center" });
      doc.moveDown(0.6);

      doc.save();
      doc.lineWidth(0.7);
      doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).stroke();
      doc.restore();
      doc.moveDown(0.5);
    }

    function renderTable(doc) {
      const pageLeft = doc.page.margins.left;
      const pageRight = doc.page.width - doc.page.margins.right;
      const contentWidth = pageRight - pageLeft;

      // column widths
      const W = {
        sr: 30,
        supplier: Math.floor(contentWidth * 0.62),
        order: contentWidth - (30 + Math.floor(contentWidth * 0.62)),
      };
      const X = {
        sr: pageLeft,
        supplier: pageLeft + W.sr,
        order: pageLeft + W.sr + W.supplier,
      };

      const drawRowBg = (y, h, isAlt) => {
        if (!isAlt) return;
        doc.save();
        doc.rect(pageLeft, y - 2, contentWidth, h).fill("#f6f8fb");
        doc.restore();
      };

      const drawHeader = () => {
        const y = doc.y;
        doc.save();
        doc.rect(pageLeft, y - 2, contentWidth, 18).fill("#e9ecef");
        doc.restore();

        doc.fillColor("#000").font("Helvetica-Bold").fontSize(10);
        doc.text("Sr", X.sr, y, { width: W.sr });
        doc.text("Supplier", X.supplier, y, { width: W.supplier });
        doc.text("Order No", X.order, y, { width: W.order, align: "right" });

        doc.moveDown(1.1);

        doc.save();
        doc.lineWidth(0.6);
        doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).stroke();
        doc.restore();

        doc.moveDown(0.25);
      };

      const headerFn = () => {
        // only table header on new page (company header is already printed separately)
        drawHeader();
      };

      drawHeader();

      if (!orders.length) {
        doc.font("Helvetica").fontSize(11).fillColor("#000");
        doc.text("No orders found for selected filters.", pageLeft, doc.y);
        return;
      }

      // Build rows
      const rows = orders.map((o) => {
        const sName = safeText(o?.supplier?.name || "Supplier");
        const ordNo = safeText(o?.order_no || o?.id);
        return { supplier: sName, orderNo: ordNo };
      });

      let sr = 1;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];

        // dynamic row height
        doc.font("Helvetica").fontSize(10);
        const hSup = doc.heightOfString(r.supplier, { width: W.supplier });
        const hOrd = doc.heightOfString(r.orderNo, { width: W.order });
        const rowH = Math.max(hSup, hOrd, 12) + 10;

        ensureSpace(doc, rowH + 10, headerFn);

        const y = doc.y;
        drawRowBg(y, rowH, i % 2 === 1);

        doc.fillColor("#000");
        doc.font("Helvetica").fontSize(10);
        doc.text(String(sr), X.sr, y, { width: W.sr });
        doc.text(r.supplier, X.supplier, y, { width: W.supplier });

        doc.font("Helvetica-Bold").fontSize(11);
        doc.text(r.orderNo, X.order, y - 1, { width: W.order, align: "right" });

        doc.y = y + rowH - 4;

        // light divider line
        doc.save();
        doc.lineWidth(0.3);
        doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).stroke();
        doc.restore();

        doc.moveDown(0.15);
        sr++;
      }
    }

    // ---- Build PDF ----
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));

    const bufPromise = new Promise((resolve, reject) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });

    await printCompanyHeader(doc);
    printTitleBlock(doc);
    renderTable(doc);

    doc.end();
    const pdfBuffer = await bufPromise;

    const fname = `supplier-order-index-${dateStr.replace(/[^\d]+/g, "-")}.pdf`;

    reply
      .header("Content-Type", "application/pdf")
      .header(
        "Content-Disposition",
        `${String(inline) === "1" ? "inline" : "attachment"}; filename="${fname}"`
      )
      .send(pdfBuffer);

    return reply;
  } catch (err) {
    request.log.error({ err }, "Error in printSupplierOrderIndexPdf");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to generate Supplier Order Index PDF",
    });
  }
};
