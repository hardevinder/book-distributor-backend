// src/controllers/schoolOrderController.js

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const PDFDocument = require("pdfkit");

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
  sequelize,
} = require("../models");

const { sendMail } = require("../config/email");
const { Op } = require("sequelize");

/* ============================================
 * Helpers
 * ============================================ */

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
      const supplierId =
        Number(reqRow.supplier_id || 0) || Number(book?.publisher?.supplier_id || 0);

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
              unit_price: null,
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
  const {
    transport_id,
    transport_through,
    transport_id_2,
    transport_through_2,
    notes,
    remarks,
  } = request.body || {};

  try {
    const order = await SchoolOrder.findOne({ where: { id: orderId } });
    if (!order) return reply.code(404).send({ message: "School order not found." });

    if (typeof transport_id !== "undefined") {
      const tidNum = transport_id === null || transport_id === "" ? null : Number(transport_id);
      order.transport_id = Number.isNaN(tidNum) ? null : tidNum;
    }

    if (typeof transport_through !== "undefined") {
      order.transport_through =
        transport_through === null || transport_through === ""
          ? null
          : String(transport_through).trim();
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
          include: [{ model: Book, as: "book", include: [{ model: Publisher, as: "publisher", attributes: ["id", "name"] }] }],
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
 * ============================================ */
exports.receiveOrderItems = async (request, reply) => {
  const { orderId } = request.params;
  const { items, status = "auto" } = request.body || {};

  if (!items || !Array.isArray(items) || !items.length) {
    return reply.code(400).send({ error: "ValidationError", message: "items array is required." });
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
    for (const it of order.items || []) itemById.set(it.id, it);

    for (const row of items) {
      const itemId = row.item_id;
      let receivedQty = Number(row.received_qty ?? 0);
      if (!itemId || Number.isNaN(receivedQty) || receivedQty < 0) continue;

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
        { model: Supplier, as: "supplier" },
        {
          model: SchoolOrderItem,
          as: "items",
          include: [{ model: Book, as: "book", include: [{ model: Publisher, as: "publisher", attributes: ["id", "name"] }] }],
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

    return reply.code(200).send({ message: "Order items updated successfully.", order: plain });
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
        { model: Supplier, as: "supplier" },
        {
          model: SchoolOrderItem,
          as: "items",
          include: [{ model: Book, as: "book", include: [{ model: Publisher, as: "publisher", attributes: ["id", "name"] }] }],
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
 * PDF builder -> Buffer
 * ✅ Updates:
 * - Only ONE number: Order No (PO removed)
 * - Order No moved to TOP before To
 * - Transport options in horizontal single line
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
      if (addrParts.length)
        lines.push({ text: addrParts.join(", "), font: "Helvetica", size: 9 });

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
    doc.text(`Order Date: ${safeText(orderDate)}`, rightTopX, topY + 1, { width: rightTopW, align: "right" });
    if (showPrintDate) {
      doc.text(`Print Date: ${safeText(dateStr)}`, rightTopX, doc.y + 2, { width: rightTopW, align: "right" });
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
    doc.text(`Total Ordered: ${totalOrdered}`, pageLeft + 10, boxY + 26, { width: contentWidth / 2 - 10 });
    doc.text(`Total Received: ${totalReceived}`, pageLeft + 10, boxY + 40, { width: contentWidth / 2 - 10 });

    doc.text(`Total Pending: ${totalPending}`, pageLeft + contentWidth / 2, boxY + 26, {
      width: contentWidth / 2 - 10,
      align: "right",
    });
    doc.text(`Completion: ${completion}%`, pageLeft + contentWidth / 2, boxY + 40, {
      width: contentWidth / 2 - 10,
      align: "right",
    });

    doc.y = boxY + boxH + 10;

    /* ---------- Table (WITH publisher column) ---------- */
    const W = {
      sr: Math.max(24, Math.floor(contentWidth * 0.06)),
      title: Math.floor(contentWidth * 0.40),
      publisher: Math.floor(contentWidth * 0.16),
      subject: Math.floor(contentWidth * 0.14),
      ord: Math.floor(contentWidth * 0.08),
      rec: Math.floor(contentWidth * 0.08),
      pend: Math.floor(contentWidth * 0.08),
    };

    const sumW = Object.values(W).reduce((a, b) => a + b, 0);
    const diff = contentWidth - sumW;
    if (diff !== 0) W.title += diff;

    const X = {
      sr: pageLeft,
      title: pageLeft + W.sr,
      publisher: pageLeft + W.sr + W.title,
      subject: pageLeft + W.sr + W.title + W.publisher,
      ord: pageLeft + W.sr + W.title + W.publisher + W.subject,
      rec: pageLeft + W.sr + W.title + W.publisher + W.subject + W.ord,
      pend: pageLeft + W.sr + W.title + W.publisher + W.subject + W.ord + W.rec,
    };

    const printTableHeader = () => {
      const y = doc.y;

      doc.save();
      doc.rect(pageLeft, y - 2, contentWidth, 18).fill("#f2f2f2");
      doc.restore();

      doc.fillColor("#000").font("Helvetica-Bold").fontSize(9);
      doc.text("Sr", X.sr, y, { width: W.sr });
      doc.text("Book Title", X.title, y, { width: W.title });
      doc.text("Publisher", X.publisher, y, { width: W.publisher });
      doc.text("Subject", X.subject, y, { width: W.subject });
      doc.text("Ordered", X.ord, y, { width: W.ord, align: "right" });
      doc.text("Received", X.rec, y, { width: W.rec, align: "right" });
      doc.text("Pending", X.pend, y, { width: W.pend, align: "right" });

      doc.moveDown(1.1);
      drawHR();
      doc.moveDown(0.25);
    };

    const rowHeight = (cells, fontSize = 9) => {
      doc.font("Helvetica").fontSize(fontSize);
      const h1 = doc.heightOfString(cells.title, { width: W.title });
      const h2 = doc.heightOfString(cells.publisher, { width: W.publisher });
      const h3 = doc.heightOfString(cells.subject, { width: W.subject });
      return Math.ceil(Math.max(h1, h2, h3, fontSize + 2)) + 6;
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

        const pubName =
          it.book?.publisher?.name ||
          (it.book?.publisher_id ? `Publisher #${it.book.publisher_id}` : "-");

        const cells = {
          title: safeText(it.book?.title || `Book #${it.book_id}`),
          publisher: safeText(pubName),
          subject: safeText(it.book?.subject || "-"),
        };

        const rh = rowHeight(cells, 9);
        ensureSpaceWithHeader(rh, printTableHeader);

        const y = doc.y;

        doc.font("Helvetica").fontSize(9).fillColor("#000");
        doc.text(String(sr), X.sr, y, { width: W.sr });
        doc.text(cells.title, X.title, y, { width: W.title });
        doc.text(cells.publisher, X.publisher, y, { width: W.publisher });
        doc.text(cells.subject, X.subject, y, { width: W.subject });
        doc.text(String(orderedQty), X.ord, y, { width: W.ord, align: "right" });
        doc.text(String(receivedQty), X.rec, y, { width: W.rec, align: "right" });
        doc.text(String(pendingQty), X.pend, y, { width: W.pend, align: "right" });

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
      drawHR();
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
 * - No PO now (only Order No)
 * - Email says: please refer PDF
 * - Regards uses CompanyProfile
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

    const school = order.school;

    const today = new Date();
    const todayStr = today.toLocaleDateString("en-IN");
    const orderDate = order.order_date ? new Date(order.order_date).toLocaleDateString("en-IN") : "-";

    const companyProfile = await CompanyProfile.findOne({
      where: { is_active: true },
      order: [["is_default", "DESC"], ["id", "ASC"]],
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
      order: [["is_default", "DESC"], ["id", "ASC"]],
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

    const toParty = { name: supplierName, address: supplierAddress, phone: supplierPhone, email: supplierEmail };

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
