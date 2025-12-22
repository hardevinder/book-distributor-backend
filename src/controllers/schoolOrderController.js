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

  // ✅ Option A: Supplier Receipt (auto-create on receive)
  SupplierReceipt,
  SupplierReceiptItem,

  // ✅ Module-2 inventory
  InventoryBatch,
  InventoryTxn,

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
const num2 = (v) => {
  const n = num(v);
  return n;
};
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const toNullIfEmpty = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

// ✅ Receipt status (must match SupplierReceipt model ENUM)
const RECEIPT_STATUS = Object.freeze({
  DRAFT: "draft",
  RECEIVED: "received",
  CANCELLED: "cancelled",
});

// ✅ SUPER SHORT order no (ONLY code)
function generateOrderNo() {
  return Math.random()
    .toString(36)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 5);
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
    Math.random()
      .toString(36)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 2)
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
 * ✅ Option A: Supplier Receipt helpers
 * - Auto-create receipt when receiving
 * ============================================================ */

function makeSupplierReceiptNo() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const suf = Math.random()
    .toString(36)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
  return `SR-${y}${m}-${suf}`;
}

/**
 * Creates (or reuses) ONE receipt per order.
 * Also links back to SchoolOrder.supplier_receipt_id + supplier_receipt_no + received_at
 *
 * NOTE: column names must match your models:
 * SupplierReceipt: supplier_id, school_order_id, receipt_no, receipt_date, status
 */
async function getOrCreateSupplierReceiptForOrder({ order, t }) {
  if (!SupplierReceipt) return null;

  // already linked?
  if (order.supplier_receipt_id) {
    const existing = await SupplierReceipt.findByPk(order.supplier_receipt_id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (existing) return existing;
  }

  // safety: find by school_order_id
  const found = await SupplierReceipt.findOne({
    where: { school_order_id: order.id },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (found) {
    // link back if missing
    try {
      if (!order.supplier_receipt_id) order.supplier_receipt_id = found.id;
      if (!order.supplier_receipt_no) order.supplier_receipt_no = found.receipt_no || null;
      if (!order.received_at) order.received_at = new Date();
      await order.save({ transaction: t });
    } catch {}
    return found;
  }

  const receiptNo = makeSupplierReceiptNo();

  const receipt = await SupplierReceipt.create(
    {
      supplier_id: order.supplier_id,
      school_order_id: order.id,
      receipt_no: receiptNo,
      receipt_date: new Date(),

      // ✅ FIX: must match ENUM('draft','received','cancelled')
      status: RECEIPT_STATUS.DRAFT,
    },
    { transaction: t }
  );

  // link back to order
  order.supplier_receipt_id = receipt.id;
  order.supplier_receipt_no = receipt.receipt_no || receiptNo;
  if (!order.received_at) order.received_at = new Date();
  await order.save({ transaction: t });

  return receipt;
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
 * Pricing helpers
 * ============================================ */
function computeLinePricing({ qtyReceived, unitPrice, discountPct, discountAmt }) {
  const up = clamp(num2(unitPrice), 0, 999999999);
  const q = clamp(num(qtyReceived), 0, 999999999);
  const dp = clamp(num2(discountPct), 0, 100);

  // if discount_amt is provided use it; else compute from pct
  let da = num2(discountAmt);
  if (!Number.isFinite(da) || da < 0) da = 0;

  const pctAmt = (up * dp) / 100;
  if (!da && dp > 0) da = pctAmt;

  // net unit price cannot be negative
  const net = Math.max(up - da, 0);
  const line = net * q;

  return {
    unit_price: up,
    discount_pct: dp,
    discount_amt: da,
    net_unit_price: net,
    line_amount: line,
  };
}

function computeOrderTotals({ items = [], charges = {} }) {
  const itemsTotal = (items || []).reduce((sum, it) => sum + num2(it.line_amount), 0);

  const freight = num2(charges.freight_charges);
  const packing = num2(charges.packing_charges);
  const other = num2(charges.other_charges);
  const overall = num2(charges.overall_discount);
  const roundOff = num2(charges.round_off);

  const sub = itemsTotal + freight + packing + other;
  const grand = sub - overall + roundOff;

  return {
    items_total: itemsTotal,
    freight_charges: freight,
    packing_charges: packing,
    other_charges: other,
    overall_discount: overall,
    round_off: roundOff,
    grand_total: grand,
  };
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
        (o.items || []).map((it) => ({
          ...it,
          pending_qty: (Number(it.total_order_qty) || 0) - (Number(it.received_qty) || 0),
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
 * one order per (school + supplier + session)
 * ✅ If nothing changed, do NOT create again
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
        orders_count: 0,
        skipped_count: 0,
        orders: [],
        skipped_orders: [],
      });
    }

    // schoolId -> supplierId -> { books: Map(bookId -> totalQty), reqRowsByBook: Map(bookId -> [reqRow]) }
    const mapBySchool = new Map();

    for (const reqRow of requirements) {
      const schoolId = reqRow.school_id;
      const book = reqRow.book;
      if (!schoolId || !book) continue;

      const qty = Number(reqRow.required_copies || 0);
      if (!qty || qty <= 0) continue;

      // supplier_id is on requirement table
      const supplierId = Number(reqRow.supplier_id || 0) || Number(book?.publisher?.supplier_id || 0);
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
      bucket.reqRowsByBook.get(bookId).push(reqRow);
    }

    if (!mapBySchool.size) {
      await t.rollback();
      return reply.code(200).send({
        message: "No valid supplier-linked items found to generate orders for this session.",
        academic_session: session,
        orders_count: 0,
        skipped_count: 0,
        orders: [],
        skipped_orders: [],
      });
    }

    const createdOrders = [];
    const skippedOrders = [];

    for (const [schoolId, bySupplier] of mapBySchool.entries()) {
      for (const [supplierId, data] of bySupplier.entries()) {
        const desiredSignature = buildItemsSignatureFromMap(data.books);

        const latestExisting = await SchoolOrder.findOne({
          where: {
            school_id: schoolId,
            supplier_id: supplierId,
            academic_session: session,
            status: { [Op.ne]: "cancelled" },
          },
          include: [{ model: SchoolOrderItem, as: "items" }],
          order: [["createdAt", "DESC"]],
          transaction: t,
          lock: t.LOCK.UPDATE,
        });

        if (latestExisting) {
          const existingSignature = buildItemsSignatureFromOrderItems(latestExisting.items || []);
          if (existingSignature === desiredSignature) {
            skippedOrders.push({
              order_id: latestExisting.id,
              order_no: latestExisting.order_no,
              school_id: latestExisting.school_id,
              supplier_id: latestExisting.supplier_id,
              academic_session: latestExisting.academic_session,
              status: latestExisting.status,
            });
            continue;
          }
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

            // totals/charges defaults
            freight_charges: 0,
            packing_charges: 0,
            other_charges: 0,
            overall_discount: 0,
            round_off: 0,
            grand_total: 0,
          },
          { transaction: t }
        );

        const linksToCreate = [];
        const requirementIdsToUpdate = new Set();

        for (const [bookId, totalQty] of data.books.entries()) {
          const q = Number(totalQty || 0);
          if (!q || q <= 0) continue;

          const item = await SchoolOrderItem.create(
            {
              school_order_id: order.id,
              book_id: bookId,
              total_order_qty: q,
              received_qty: 0,

              // commercial
              unit_price: null,
              discount_pct: null,
              discount_amt: null,
              net_unit_price: null,
              line_amount: null,

              // legacy
              total_amount: null,
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
            requirementIdsToUpdate.add(rr.id);
          }
        }

        if (linksToCreate.length) {
          await SchoolRequirementOrderLink.bulkCreate(linksToCreate, { transaction: t });
        }

        // (kept as-is)
        if (requirementIdsToUpdate.size > 0) {
          await SchoolBookRequirement.update(
            { status: "confirmed" },
            { where: { id: Array.from(requirementIdsToUpdate) }, transaction: t }
          );
        }

        createdOrders.push(order);
      }
    }

    await t.commit();

    return reply.code(201).send({
      message:
        createdOrders.length > 0
          ? "Supplier-wise school orders generated successfully."
          : "No changes found — orders already up-to-date.",
      academic_session: session,
      orders_count: createdOrders.length,
      skipped_count: skippedOrders.length,
      orders: createdOrders,
      skipped_orders: skippedOrders,
    });
  } catch (err) {
    try {
      if (!t.finished) await t.rollback();
    } catch {}
    console.error("Error in generateOrdersForSession:", err);
    return reply.code(500).send({
      error: "Error",
      message: err.message || "Failed to generate supplier-wise orders.",
    });
  }
};

/* ============================================
 * PATCH /api/school-orders/:orderId/meta
 * ============================================ */
exports.updateSchoolOrderMeta = async (request, reply) => {
  const { orderId } = request.params;
  const { transport_id, transport_through, transport_id_2, transport_through_2, notes, remarks } =
    request.body || {};

  try {
    const order = await SchoolOrder.findOne({ where: { id: orderId } });
    if (!order) return reply.code(404).send({ message: "School order not found." });

    if (typeof transport_id !== "undefined") {
      const tidNum = transport_id === null || transport_id === "" ? null : Number(transport_id);
      order.transport_id = Number.isNaN(tidNum) ? null : tidNum;
    }

    if (typeof transport_through !== "undefined") {
      order.transport_through =
        transport_through === null || transport_through === "" ? null : String(transport_through).trim();
    }

    if ("transport_id_2" in order && typeof transport_id_2 !== "undefined") {
      const tidNum2 = transport_id_2 === null || transport_id_2 === "" ? null : Number(transport_id_2);
      order.transport_id_2 = Number.isNaN(tidNum2) ? null : tidNum2;
    }

    if ("transport_through_2" in order && typeof transport_through_2 !== "undefined") {
      order.transport_through_2 =
        transport_through_2 === null || transport_through_2 === ""
          ? null
          : String(transport_through_2).trim();
    }

    if (typeof notes !== "undefined") {
      order.notes = notes === null || notes === "" ? null : String(notes).trim();
    }

    if (typeof remarks !== "undefined") {
      order.remarks = remarks === null || remarks === "" ? null : String(remarks).trim();
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
      ],
    });

    const plain = updated.toJSON();
    plain.items =
      (plain.items || []).map((it) => ({
        ...it,
        pending_qty: (Number(it.total_order_qty) || 0) - (Number(it.received_qty) || 0),
      })) || [];

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
 *
 * ✅ No duplicate saving:
 * - If frontend sends same request again => delta becomes 0 => no InventoryTxn created.
 * - If items array contains duplicate item_id rows in SAME request => we normalize (one per item_id).
 *
 * ✅ ALSO pushes Inventory (delta-based)
 * ✅ BLOCK decrease (delta < 0)
 * ✅ IF cancelled => no inventory add
 *
 * ✅ NEW:
 * - saves item commercial fields (unit_price/discount/net/line)
 * - saves order charges (freight/packing/other/overall_discount/round_off/grand_total)
 * - ✅ Option A: auto-create SupplierReceipt + SupplierReceiptItems
 * ============================================ */
exports.receiveOrderItems = async (request, reply) => {
  const { orderId } = request.params;

  // accept charges in payload
  const { items, status = "auto", charges } = request.body || {};

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

    // ✅ Safety: supplier_id must exist for inventory + receipt
    if (!order.supplier_id) {
      await t.rollback();
      return reply.code(400).send({
        error: "ValidationError",
        message: "Order supplier_id missing. Cannot receive.",
      });
    }

    // ✅ Option A: Auto-create/attach SupplierReceipt when receiving (not cancelled)
    let supplierReceipt = null;
    if (!isCancelled) {
      supplierReceipt = await getOrCreateSupplierReceiptForOrder({ order, t });
    }

    // ✅ Normalize payload to avoid duplicate item_id rows in same request
    // strategy: keep the last row per item_id (usually latest typed values)
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

    // Track updated items for totals
    const updatedItemsForTotals = [];

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

      // ✅ BLOCK decreasing (inventory mismatch avoid)
      if (delta < 0) {
        throw new Error(
          `Received qty cannot be reduced (Item #${item.id}). Use inventory adjustment if needed.`
        );
      }

      // If no change, still allow price updates (optional) but DO NOT create inventory txn
      const pricing = computeLinePricing({
        qtyReceived: newReceived,
        unitPrice: row.unit_price ?? row.rate ?? item.unit_price ?? null,
        discountPct: row.discount_pct ?? row.discountPercent ?? item.discount_pct ?? null,
        discountAmt: row.discount_amt ?? row.discountAmount ?? item.discount_amt ?? null,
      });

      item.received_qty = newReceived;

      item.unit_price = pricing.unit_price;
      if ("discount_pct" in item) item.discount_pct = pricing.discount_pct;
      if ("discount_amt" in item) item.discount_amt = pricing.discount_amt;
      if ("net_unit_price" in item) item.net_unit_price = pricing.net_unit_price;
      if ("line_amount" in item) item.line_amount = pricing.line_amount;

      // legacy field (keep in sync if exists)
      if ("total_amount" in item) item.total_amount = pricing.line_amount;

      await item.save({ transaction: t });

      updatedItemsForTotals.push(item);

      // ✅ Option A: Upsert SupplierReceiptItem (idempotent)
      if (!isCancelled && supplierReceipt && SupplierReceiptItem) {
        const [rItem, created] = await SupplierReceiptItem.findOrCreate({
          where: {
            supplier_receipt_id: supplierReceipt.id,
            book_id: item.book_id,
          },
          defaults: {
            supplier_receipt_id: supplierReceipt.id,
            book_id: item.book_id,

            ordered_qty: ordered,
            received_qty: newReceived,

            // pricing snapshot (if columns exist)
            unit_price: item.unit_price ?? null,
            discount_pct: item.discount_pct ?? null,
            discount_amt: item.discount_amt ?? null,
            net_unit_price: item.net_unit_price ?? null,
            line_amount: item.line_amount ?? null,
          },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });

        if (!created) {
          rItem.ordered_qty = ordered;
          rItem.received_qty = newReceived;

          if ("unit_price" in rItem) rItem.unit_price = item.unit_price ?? rItem.unit_price ?? null;
          if ("discount_pct" in rItem) rItem.discount_pct = item.discount_pct ?? rItem.discount_pct ?? null;
          if ("discount_amt" in rItem) rItem.discount_amt = item.discount_amt ?? rItem.discount_amt ?? null;
          if ("net_unit_price" in rItem)
            rItem.net_unit_price = item.net_unit_price ?? rItem.net_unit_price ?? null;
          if ("line_amount" in rItem) rItem.line_amount = item.line_amount ?? rItem.line_amount ?? null;

          await rItem.save({ transaction: t });
        }
      }

      // ✅ If cancelled => do not add inventory
      if (!isCancelled && delta > 0) {
        // Find a stable batch per order+item+book+supplier (idempotent)
        let batch = await InventoryBatch.findOne({
          where: {
            school_order_id: order.id,
            school_order_item_id: item.id,
            book_id: item.book_id,
            supplier_id: order.supplier_id,
          },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });

        if (!batch) {
          batch = await InventoryBatch.create(
            {
              book_id: item.book_id,
              supplier_id: order.supplier_id,
              school_order_id: order.id,
              school_order_item_id: item.id,

              // ✅ Use net_unit_price if available else unit_price
              purchase_price:
                item.net_unit_price != null
                  ? item.net_unit_price
                  : item.unit_price != null
                  ? item.unit_price
                  : null,

              received_qty: 0,
              available_qty: 0,
            },
            { transaction: t }
          );
        } else {
          // keep latest purchase price (optional)
          try {
            const pp =
              item.net_unit_price != null
                ? item.net_unit_price
                : item.unit_price != null
                ? item.unit_price
                : null;
            if (pp != null) batch.purchase_price = pp;
          } catch {}
        }

        batch.received_qty = Number(batch.received_qty || 0) + delta;
        batch.available_qty = Number(batch.available_qty || 0) + delta;
        await batch.save({ transaction: t });

        // ✅ delta-based IN txn (idempotent by design due to delta)
        await InventoryTxn.create(
          {
            txn_type: "IN",
            book_id: item.book_id,
            batch_id: batch.id,
            qty: delta,
            ref_type: "SCHOOL_ORDER_RECEIVE",
            ref_id: order.id,
            notes: `Receive against order_no ${order.order_no || order.id}`,
          },
          { transaction: t }
        );
      }
    }

    // --- save order-level charges/totals (only when not cancelled) ---
    if (!isCancelled) {
      const totals = computeOrderTotals({
        items: updatedItemsForTotals.length ? updatedItemsForTotals : order.items || [],
        charges: charges || {},
      });

      if ("freight_charges" in order) order.freight_charges = totals.freight_charges;
      if ("packing_charges" in order) order.packing_charges = totals.packing_charges;
      if ("other_charges" in order) order.other_charges = totals.other_charges;
      if ("overall_discount" in order) order.overall_discount = totals.overall_discount;
      if ("round_off" in order) order.round_off = totals.round_off;
      if ("grand_total" in order) order.grand_total = totals.grand_total;

      // stamp received_at once
      if ("received_at" in order && !order.received_at) order.received_at = new Date();

      await order.save({ transaction: t });
    }

    if (isCancelled) {
      order.status = "cancelled";
      await order.save({ transaction: t });

      // optional: cancel receipt too (only if it exists)
      if (supplierReceipt && "status" in supplierReceipt) {
        supplierReceipt.status = RECEIPT_STATUS.CANCELLED;
        await supplierReceipt.save({ transaction: t });
      }
    } else {
      await recomputeOrderStatus(order, t);
    }

    // ✅ Option A: update receipt totals/status
    if (!isCancelled && supplierReceipt && SupplierReceiptItem) {
      const rItems = await SupplierReceiptItem.findAll({
        where: { supplier_receipt_id: supplierReceipt.id },
        transaction: t,
      });

      const itemsTotal = rItems.reduce((s, x) => s + num2(x.line_amount), 0);

      // NOTE: model has sub_total + grand_total (not items_total)
      if ("sub_total" in supplierReceipt) supplierReceipt.sub_total = itemsTotal;
      if ("grand_total" in supplierReceipt) supplierReceipt.grand_total = itemsTotal;

      // ✅ FIX: must match ENUM('draft','received','cancelled')
      if ("status" in supplierReceipt) supplierReceipt.status = RECEIPT_STATUS.RECEIVED;

      await supplierReceipt.save({ transaction: t });
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
      ],
      transaction: t,
    });

    await t.commit();

    const plain = updated.toJSON();
    plain.items =
      (plain.items || []).map((it) => ({
        ...it,
        pending_qty: (Number(it.total_order_qty) || 0) - (Number(it.received_qty) || 0),
      })) || [];

    // include receipt info in response (handy for frontend)
    if (supplierReceipt) {
      plain.supplier_receipt_id = supplierReceipt.id;
      plain.supplier_receipt_no = supplierReceipt.receipt_no || plain.supplier_receipt_no || null;
    }

    return reply.code(200).send({
      message: "Order items updated successfully.",
      order: plain,
    });
  } catch (err) {
    try {
      if (!t.finished) await t.rollback();
    } catch {}
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
      include: [{ model: School, as: "school" }, { model: SchoolOrderItem, as: "items" }],
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
      if (pending > 0) pendingItems.push({ book_id: it.book_id, pending_qty: pending });
    }

    if (!pendingItems.length) {
      await t.rollback();
      return reply.code(400).send({ message: "No pending quantity found to re-order for this order." });
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
        remarks: `Re-order for pending quantity of ${sourceOrder.order_no}`,

        freight_charges: 0,
        packing_charges: 0,
        other_charges: 0,
        overall_discount: 0,
        round_off: 0,
        grand_total: 0,
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
          discount_pct: null,
          discount_amt: null,
          net_unit_price: null,
          line_amount: null,

          total_amount: null,
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

/* ============================================================
 * ✅ NEW (Module-2): School -> Book wise availability
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

/* ============================================================
 * PDF builder -> Buffer
 * ✅ Publisher column removed
 * ✅ Ordered/Received/Pending are FIXED WIDE + bold
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
}) {
  return new Promise(async (resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

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

    const ensureSpaceWithHeader = (neededHeight, printHeaderFn) => {
      const bottom = doc.page.height - doc.page.margins.bottom;
      if (doc.y + neededHeight > bottom) {
        doc.addPage();
        if (typeof printHeaderFn === "function") printHeaderFn();
      }
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

    const orderNoText = safeText(order.order_no || order.id);

    doc.font("Helvetica-Bold").fontSize(13).fillColor("#000");
    doc.text(`Order No: ${orderNoText}`, pageLeft, topY, { width: leftTopW, align: "left" });

    doc.font("Helvetica").fontSize(9).fillColor("#000");
    doc.text(`Order Date: ${safeText(orderDate)}`, rightTopX, topY + 1, {
      width: rightTopW,
      align: "right",
    });
    if (showPrintDate) {
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

    /* ---------- To (Supplier) BELOW order no ---------- */
    if (toParty && toParty.name) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#000");
      doc.text("To:", pageLeft, doc.y);

      doc.font("Helvetica").fontSize(10).fillColor("#000");
      doc.text(safeText(toParty.name), pageLeft, doc.y);

      const subLines = [];
      if (toParty.address) subLines.push(safeText(toParty.address));
      if (toParty.phone) subLines.push(`Phone: ${safeText(toParty.phone)}`);
      if (toParty.email) subLines.push(`Email: ${safeText(toParty.email)}`);

      doc.font("Helvetica").fontSize(9).fillColor("#000");
      for (const ln of subLines) {
        doc.text(ln, pageLeft, doc.y, { width: Math.floor(contentWidth * 0.72) });
      }
    }

    doc.moveDown(0.25);
    drawHR();
    doc.moveDown(0.4);

    /* ---------- Summary (boxed) ---------- */
    const totalOrdered = items.reduce((sum, it) => sum + (Number(it.total_order_qty) || 0), 0);
    const totalReceived = items.reduce((sum, it) => sum + (Number(it.received_qty) || 0), 0);
    const totalPending = Math.max(totalOrdered - totalReceived, 0);
    const completion = totalOrdered > 0 ? Math.round((totalReceived / totalOrdered) * 100) : 0;

    const boxY = doc.y;
    const boxH = 58;

    doc.save();
    doc.rect(pageLeft, boxY, contentWidth, boxH).fill("#f6f8fb");
    doc.restore();

    doc.font("Helvetica-Bold").fontSize(10).fillColor("#000");
    doc.text("Summary", pageLeft + 10, boxY + 8);

    doc.font("Helvetica").fontSize(9).fillColor("#000");
    doc.text(`Total Ordered: ${totalOrdered}`, pageLeft + 10, boxY + 26, {
      width: contentWidth / 2 - 10,
    });
    doc.text(`Total Received: ${totalReceived}`, pageLeft + 10, boxY + 40, {
      width: contentWidth / 2 - 10,
    });

    doc.text(`Total Pending: ${totalPending}`, pageLeft + contentWidth / 2, boxY + 26, {
      width: contentWidth / 2 - 10,
      align: "right",
    });
    doc.text(`Completion: ${completion}%`, pageLeft + contentWidth / 2, boxY + 40, {
      width: contentWidth / 2 - 10,
      align: "right",
    });

    doc.y = boxY + boxH + 10;

    /* ---------- Table (NO publisher) — FIXED WIDE OR/RC/PD ---------- */
    const W = {
      sr: 26,
      title: 0, // auto
      subject: 70,
      ord: 85,
      rec: 85,
      pend: 85,
    };

    W.title = contentWidth - (W.sr + W.subject + W.ord + W.rec + W.pend);

    if (W.title < 140) {
      const need = 140 - W.title;
      W.subject = Math.max(60, W.subject - need);
      W.title = contentWidth - (W.sr + W.subject + W.ord + W.rec + W.pend);
    }

    const X = {
      sr: pageLeft,
      title: pageLeft + W.sr,
      subject: pageLeft + W.sr + W.title,
      ord: pageLeft + W.sr + W.title + W.subject,
      rec: pageLeft + W.sr + W.title + W.subject + W.ord,
      pend: pageLeft + W.sr + W.title + W.subject + W.ord + W.rec,
    };

    const drawHR2 = () => {
      doc.save();
      doc.lineWidth(0.6);
      doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).stroke();
      doc.restore();
    };

    const printTableHeader = () => {
      const y = doc.y;

      doc.save();
      doc.rect(pageLeft, y - 2, contentWidth, 18).fill("#f2f2f2");
      doc.restore();

      doc.fillColor("#000").font("Helvetica-Bold").fontSize(9);
      doc.text("Sr", X.sr, y, { width: W.sr });
      doc.text("Book Title", X.title, y, { width: W.title });
      doc.text("Subject", X.subject, y, { width: W.subject });

      doc.font("Helvetica-Bold").fontSize(10);
      doc.text("Ordered", X.ord, y - 1, { width: W.ord, align: "center", lineBreak: false, height: 14 });
      doc.text("Received", X.rec, y - 1, { width: W.rec, align: "center", lineBreak: false, height: 14 });
      doc.text("Pending", X.pend, y - 1, { width: W.pend, align: "center", lineBreak: false, height: 14 });

      doc.moveDown(1.1);
      drawHR2();
      doc.moveDown(0.25);
    };

    const rowHeight = (cells, fontSize = 9) => {
      doc.font("Helvetica").fontSize(fontSize);
      const h1 = doc.heightOfString(cells.title, { width: W.title });
      const h2 = doc.heightOfString(cells.subject, { width: W.subject });
      return Math.ceil(Math.max(h1, h2, fontSize + 2)) + 6;
    };

    printTableHeader();

    if (!items.length) {
      doc.font("Helvetica").fontSize(10).fillColor("#000");
      doc.text("No items found in this order.", { align: "left" });
    } else {
      let sr = 1;
      for (const it of items) {
        const orderedQty = Number(it.total_order_qty) || 0;
        const receivedQty = Number(it.received_qty) || 0;
        const pendingQty = Math.max(orderedQty - receivedQty, 0);

        const cells = {
          title: safeText(it.book?.title || `Book #${it.book_id}`),
          subject: safeText(it.book?.subject || "-"),
        };

        const rh = rowHeight(cells, 9);
        ensureSpaceWithHeader(rh, printTableHeader);

        const y = doc.y;

        doc.font("Helvetica").fontSize(9).fillColor("#000");
        doc.text(String(sr), X.sr, y, { width: W.sr });
        doc.text(cells.title, X.title, y, { width: W.title });
        doc.text(cells.subject, X.subject, y, { width: W.subject });

        doc.font("Helvetica-Bold").fontSize(10);
        doc.text(String(orderedQty), X.ord, y - 1, { width: W.ord, align: "center", lineBreak: false });
        doc.text(String(receivedQty), X.rec, y - 1, { width: W.rec, align: "center", lineBreak: false });
        doc.text(String(pendingQty), X.pend, y - 1, { width: W.pend, align: "center", lineBreak: false });

        doc.y = y + rh - 3;
        sr++;
      }
    }

    /* ---------- Transport (BOTTOM) - HORIZONTAL ---------- */
    const t1Through = order.transport_through || null;
    const t1Name = order.transport?.name || order.transport_name || null;
    const t1City = order.transport?.city || null;
    const t1Phone = order.transport?.phone || null;

    let t2Obj = null;
    if ("transport_id_2" in order && order.transport_id_2) {
      try {
        t2Obj = await Transport.findByPk(order.transport_id_2);
      } catch {}
    }

    const t2Through =
      "transport_through_2" in order && order.transport_through_2 ? order.transport_through_2 : null;
    const t2Name = t2Obj?.name || null;
    const t2City = t2Obj?.city || null;
    const t2Phone = t2Obj?.phone || null;

    const opt1Parts = [];
    if (t1Through) opt1Parts.push(t1Through);
    else if (t1Name) opt1Parts.push(`${t1Name}${t1City ? " (" + t1City + ")" : ""}`);
    if (t1Phone) opt1Parts.push(`Ph: ${t1Phone}`);

    const opt2Parts = [];
    if (t2Through) opt2Parts.push(t2Through);
    else if (t2Name) opt2Parts.push(`${t2Name}${t2City ? " (" + t2City + ")" : ""}`);
    if (t2Phone) opt2Parts.push(`Ph: ${t2Phone}`);

    const transportLineParts = [];
    if (opt1Parts.length) transportLineParts.push(`Option 1: ${opt1Parts.join(" | ")}`);
    if (opt2Parts.length) transportLineParts.push(`OR Option 2: ${opt2Parts.join(" | ")}`);

    if (transportLineParts.length) {
      const combined = transportLineParts.join("    •    ");
      const approxH = doc.heightOfString(combined, { width: contentWidth }) + 28;
      ensureSpaceWithHeader(approxH, printTableHeader);

      doc.moveDown(0.4);
      drawHR2();
      doc.moveDown(0.25);

      doc.font("Helvetica-Bold").fontSize(10).fillColor("#000");
      doc.text("Transport", pageLeft);

      doc.moveDown(0.15);
      doc.font("Helvetica").fontSize(9).fillColor("#000");
      doc.text(combined, pageLeft, doc.y, { width: contentWidth, align: "left" });
    }

    /* ---------- Notes (HIGHLIGHTED FOOTER) ---------- */
    if (order.notes) {
      const noteText = safeText(order.notes);
      const noteH = Math.max(38, doc.heightOfString(noteText, { width: contentWidth - 20 }) + 22);

      const bottom = doc.page.height - doc.page.margins.bottom;
      if (doc.y + noteH + 10 > bottom) doc.addPage();

      doc.moveDown(0.5);

      const y = doc.y;
      doc.save();
      doc.rect(pageLeft, y, contentWidth, noteH).fill("#fff3cd");
      doc.restore();

      doc.font("Helvetica-Bold").fontSize(10).fillColor("#000");
      doc.text("Notes", pageLeft + 10, y + 8);

      doc.font("Helvetica").fontSize(9).fillColor("#000");
      doc.text(noteText, pageLeft + 10, y + 22, {
        width: contentWidth - 20,
        align: "left",
      });

      doc.y = y + noteH + 2;
    }

    doc.end();
  });
}

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
      ],
    });

    if (!order) return reply.code(404).send({ message: "School order not found." });

    const supplier = order.supplier;
    if (!supplier) {
      return reply.code(400).send({
        message: "Supplier not linked with this order. Please set school_orders.supplier_id.",
      });
    }
    if (!supplier.email) {
      return reply.code(400).send({ message: `Supplier email not set for "${supplier.name}".` });
    }

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

    const safeOrderNo = String(order.order_no || `order-${order.id}`).replace(/[^\w\-]+/g, "_");

    const supplierName = supplier.name;
    const supplierEmail = supplier.email;
    const supplierPhone = supplier.phone || supplier.phone_primary || "";
    const supplierAddress = supplier.address || supplier.address_line1 || supplier.full_address || "";

    const toParty = {
      name: supplierName,
      address: supplierAddress,
      phone: supplierPhone,
      email: supplierEmail,
    };

    const subject = `Purchase Order – Order No ${order.order_no || order.id} – ${supplierName}`;

    const cp = companyProfile ? companyProfile.toJSON?.() || companyProfile : null;
    const cpName = cp?.name || "EduBridge ERP";
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

    const html = `
      <p>Dear ${supplierName},</p>

      <p>
        Please find the attached <strong>Purchase Order PDF</strong>.
        Kindly refer to the PDF for all item details, quantities, and transport information.
      </p>

      <h3>Quick Info</h3>
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

    const orderForPdf = order.toJSON();
    orderForPdf.transport = order.transport ? order.transport.toJSON?.() || order.transport : null;

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
    });

    const filename = `school-order-${safeOrderNo}-supplier-${order.supplier_id}.pdf`;
    const cc = process.env.ORDER_EMAIL_CC || process.env.SMTP_USER;

    const info = await sendMail({
      to: supplierEmail,
      cc,
      subject,
      html,
      replyTo: cpEmail || undefined,
      attachments: [{ filename, content: pdfBuffer, contentType: "application/pdf" }],
    });

    try {
      order.status = "sent";
      if ("email_sent_at" in order) order.email_sent_at = new Date();
      await order.save();
    } catch {}

    return reply.code(200).send({
      message: "Supplier purchase order email (with PDF) sent successfully.",
      order_id: order.id,
      supplier_id: order.supplier_id,
      to: supplierEmail,
      order_no: order.order_no || order.id,
      message_id: info.messageId,
    });
  } catch (err) {
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
      return reply.code(404).send({ error: "NotFound", message: "School order not found" });
    }

    const items = order.items || [];
    const today = new Date();
    const dateStr = today.toLocaleDateString("en-IN");
    const orderDate = order.order_date ? new Date(order.order_date).toLocaleDateString("en-IN") : "-";

    const supplier = order.supplier;
    const supplierName = supplier?.name || "Supplier";
    const supplierAddress = supplier?.address || "";
    const supplierPhone = supplier?.phone || "";
    const supplierEmail = supplier?.email || "";

    const toParty = {
      name: supplierName,
      address: supplierAddress,
      phone: supplierPhone,
      email: supplierEmail,
    };

    const orderForPdf = order.toJSON();
    orderForPdf.transport = order.transport ? order.transport.toJSON?.() || order.transport : null;

    const safeOrderNo = String(order.order_no || `order-${order.id}`).replace(/[^\w\-]+/g, "_");

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
