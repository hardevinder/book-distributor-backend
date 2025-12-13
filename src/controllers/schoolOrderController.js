// src/controllers/schoolOrderController.js

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
// Example: 0N9A7   (5 chars)
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

// ✅ Stable signature to detect "no changes" per school+session
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
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
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
        { model: Transport, as: "transport" },
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
 * ✅ If nothing changed, do NOT create again
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
      where: { academic_session: session, status: "confirmed" },
      include: [{ model: Book, as: "book" }, { model: School, as: "school" }],
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

    // schoolId -> { books: Map(bookId -> totalQty), reqRowsByBook: Map(bookId -> [reqRow]) }
    const mapBySchool = new Map();

    for (const reqRow of requirements) {
      const schoolId = reqRow.school_id;
      const book = reqRow.book;
      if (!schoolId || !book) continue;

      const qty = Number(reqRow.required_copies || 0);
      if (!qty || qty <= 0) continue;

      const bookId = book.id;

      if (!mapBySchool.has(schoolId)) {
        mapBySchool.set(schoolId, { books: new Map(), reqRowsByBook: new Map() });
      }

      const schoolBucket = mapBySchool.get(schoolId);

      schoolBucket.books.set(
        bookId,
        (Number(schoolBucket.books.get(bookId)) || 0) + qty
      );

      if (!schoolBucket.reqRowsByBook.has(bookId))
        schoolBucket.reqRowsByBook.set(bookId, []);
      schoolBucket.reqRowsByBook.get(bookId).push(reqRow);
    }

    if (!mapBySchool.size) {
      await t.rollback();
      return reply.code(200).send({
        message:
          "No positive quantity found to generate school orders for this session.",
        academic_session: session,
        orders_count: 0,
        skipped_count: 0,
        orders: [],
        skipped_orders: [],
      });
    }

    const createdOrders = [];
    const skippedOrders = [];

    for (const [schoolId, data] of mapBySchool.entries()) {
      const desiredSignature = buildItemsSignatureFromMap(data.books);

      // ✅ Check latest existing order for same school+session
      const latestExisting = await SchoolOrder.findOne({
        where: {
          school_id: schoolId,
          academic_session: session,
          status: { [Op.ne]: "cancelled" },
        },
        include: [{ model: SchoolOrderItem, as: "items" }],
        order: [["createdAt", "DESC"]],
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      if (latestExisting) {
        const existingSignature = buildItemsSignatureFromOrderItems(
          latestExisting.items || []
        );

        // ✅ If signature matches, skip generating again
        if (existingSignature === desiredSignature) {
          skippedOrders.push({
            order_id: latestExisting.id,
            order_no: latestExisting.order_no,
            school_id: latestExisting.school_id,
            academic_session: latestExisting.academic_session,
            status: latestExisting.status,
          });
          continue;
        }
      }

      // ✅ Create new order (only when changed OR no existing)
      const orderNo = await generateUniqueOrderNo(t);

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

      for (const [bookId, totalQty] of data.books.entries()) {
        const qty = Number(totalQty || 0);
        if (!qty || qty <= 0) continue;

        const item = await SchoolOrderItem.create(
          {
            school_order_id: order.id,
            book_id: bookId,
            total_order_qty: qty,
            received_qty: 0,
            unit_price: null,
            total_amount: null,
          },
          { transaction: t }
        );

        const reqRows = data.reqRowsByBook.get(bookId) || [];
        for (const reqRow of reqRows) {
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
          { status: "confirmed" },
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
      message:
        createdOrders.length > 0
          ? "School orders generated successfully."
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
      message: err.message || "Failed to generate school orders.",
    });
  }
};

/* ============================================
 * PATCH /api/school-orders/:orderId/meta
 * ============================================ */
exports.updateSchoolOrderMeta = async (request, reply) => {
  const { orderId } = request.params;
  const { transport_id, transport_through, notes, remarks } = request.body || {};

  try {
    const order = await SchoolOrder.findOne({ where: { id: orderId } });
    if (!order)
      return reply.code(404).send({ message: "School order not found." });

    if (typeof transport_id !== "undefined") {
      const tidNum =
        transport_id === null || transport_id === ""
          ? null
          : Number(transport_id);
      order.transport_id = Number.isNaN(tidNum) ? null : tidNum;
    }

    if (typeof transport_through !== "undefined") {
      order.transport_through =
        transport_through === null || transport_through === ""
          ? null
          : String(transport_through).trim();
    }

    if (typeof notes !== "undefined") {
      order.notes = notes === null || notes === "" ? null : String(notes).trim();
    }

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
        { model: Transport, as: "transport" },
      ],
    });

    const plain = updated.toJSON();
    plain.items =
      (plain.items || []).map((it) => ({
        ...it,
        pending_qty:
          (Number(it.total_order_qty) || 0) - (Number(it.received_qty) || 0),
      })) || [];

    return reply
      .code(200)
      .send({ message: "Order meta updated successfully.", order: plain });
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
    return reply
      .code(400)
      .send({ error: "ValidationError", message: "order_no is required." });
  }

  try {
    const order = await SchoolOrder.findByPk(orderId);
    if (!order)
      return reply.code(404).send({ message: "School order not found." });

    const dup = await SchoolOrder.findOne({
      where: { order_no: newNo, id: { [Op.ne]: order.id } },
    });
    if (dup)
      return reply.code(400).send({
        error: "DuplicateOrderNo",
        message: "This order number already exists.",
      });

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
    return reply
      .code(400)
      .send({ error: "ValidationError", message: "items array is required." });
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
        { model: Transport, as: "transport" },
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

    return reply
      .code(200)
      .send({ message: "Order items updated successfully.", order: plain });
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
      if (pending > 0) pendingItems.push({ book_id: it.book_id, pending_qty: pending });
    }

    if (!pendingItems.length) {
      await t.rollback();
      return reply.code(400).send({
        message: "No pending quantity found to re-order for this order.",
      });
    }

    const newOrderNo = await generateUniqueOrderNo(t);

    const newOrder = await SchoolOrder.create(
      {
        school_id: sourceOrder.school_id,
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
 * PDF builder -> Buffer (FINAL POLISHED)
 * - Title width reduced (centered but constrained)
 * - Ordered/Received/Pending full words
 * - Publisher column removed
 * ============================================================ */
function buildSchoolOrderPdfBuffer({
  order,
  companyProfile,
  items,
  pdfTitle,
  publisherNameForHeader,
  dateStr,
  orderDate,
  isPurchaseOrder = false,
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
        lines.push({ text: companyProfile.name, font: "Helvetica-Bold", size: 13 });
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

    /* ---------- Title (reduced width) ---------- */
    doc.font("Helvetica-Bold").fontSize(isPurchaseOrder ? 16 : 14).fillColor("#000");
    const titleBoxW = Math.floor(contentWidth * 0.72); // ✅ narrower title block
    const titleX = pageLeft + Math.floor((contentWidth - titleBoxW) / 2);
    doc.text(safeText(pdfTitle), titleX, doc.y, { width: titleBoxW, align: "center" });
    doc.moveDown(0.15);

    /* ---------- To ---------- */
    if (publisherNameForHeader) {
      doc.font("Helvetica").fontSize(9).text("To:", pageLeft);
      doc.font("Helvetica-Bold").fontSize(10).text(safeText(publisherNameForHeader), pageLeft);
      doc.moveDown(0.15);
    }

    /* ---------- Meta ---------- */
    doc.font("Helvetica").fontSize(9);
    doc.text(`Order No: ${safeText(order.order_no || order.id)}`, pageLeft);
    doc.text(`Order Date: ${orderDate}   |   Print: ${dateStr}`, pageLeft, doc.y + 2);
    doc.moveDown(0.3);
    drawHR();
    doc.moveDown(0.35);

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

    doc.font("Helvetica").fontSize(9);
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

    /* ---------- Table (NO publisher column) ---------- */
    const W = {
      sr: Math.max(24, Math.floor(contentWidth * 0.06)),
      title: Math.floor(contentWidth * 0.52),
      subject: Math.floor(contentWidth * 0.16),
      ord: Math.floor(contentWidth * 0.09),
      rec: Math.floor(contentWidth * 0.09),
      pend: Math.floor(contentWidth * 0.08),
    };

    const sumW = Object.values(W).reduce((a, b) => a + b, 0);
    const diff = contentWidth - sumW;
    if (diff !== 0) W.title += diff;

    const X = {
      sr: pageLeft,
      title: pageLeft + W.sr,
      subject: pageLeft + W.sr + W.title,
      ord: pageLeft + W.sr + W.title + W.subject,
      rec: pageLeft + W.sr + W.title + W.subject + W.ord,
      pend: pageLeft + W.sr + W.title + W.subject + W.ord + W.rec,
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
      doc.text("Ordered", X.ord, y, { width: W.ord, align: "right" });
      doc.text("Received", X.rec, y, { width: W.rec, align: "right" });
      doc.text("Pending", X.pend, y, { width: W.pend, align: "right" });

      doc.moveDown(1.1);
      drawHR();
      doc.moveDown(0.25);
    };

    const ensureSpaceWithHeader = (neededHeight) => {
      const bottom = doc.page.height - doc.page.margins.bottom;
      if (doc.y + neededHeight > bottom) {
        doc.addPage();
        printTableHeader();
      }
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
        ensureSpaceWithHeader(rh);

        const y = doc.y;

        doc.font("Helvetica").fontSize(9).fillColor("#000");
        doc.text(String(sr), X.sr, y, { width: W.sr });
        doc.text(cells.title, X.title, y, { width: W.title });
        doc.text(cells.subject, X.subject, y, { width: W.subject });
        doc.text(String(orderedQty), X.ord, y, { width: W.ord, align: "right" });
        doc.text(String(receivedQty), X.rec, y, { width: W.rec, align: "right" });
        doc.text(String(pendingQty), X.pend, y, { width: W.pend, align: "right" });

        doc.y = y + rh - 3;
        sr++;
      }
    }

    /* ---------- Transport + Notes (BOTTOM) ---------- */
    const transportLines = [];
    const transportThrough = order.transport_through || null;
    const transportName = order.transport?.name || order.transport_name || null;
    const transportCity = order.transport?.city || null;
    const transportPhone = order.transport?.phone || null;

    if (transportThrough) transportLines.push(`Through: ${transportThrough}`);
    else if (transportName)
      transportLines.push(
        `Through: ${transportName}${transportCity ? " (" + transportCity + ")" : ""}`
      );
    if (transportPhone) transportLines.push(`Transport Phone: ${transportPhone}`);
    if (order.notes) transportLines.push(`Notes: ${order.notes}`);

    if (transportLines.length) {
      const approx = 18 + transportLines.length * 12 + 16;
      ensureSpaceWithHeader(approx);

      doc.moveDown(0.4);
      drawHR();
      doc.moveDown(0.25);

      doc.font("Helvetica-Bold").fontSize(10).fillColor("#000");
      doc.text("Transport / Notes", pageLeft);

      doc.moveDown(0.15);
      doc.font("Helvetica").fontSize(9).fillColor("#000");
      for (const line of transportLines) {
        doc.text(safeText(line), { width: contentWidth, align: "left" });
      }
    }

    doc.end();
  });
}

/* ============================================
 * POST /api/school-orders/:orderId/send-email
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
              include: [{ model: Publisher, as: "publisher", attributes: ["id", "name"] }],
            },
          ],
        },
        { model: Transport, as: "transport" },
      ],
    });

    if (!order) return reply.code(404).send({ message: "School order not found." });

    const school = order.school;
    const items = order.items || [];

    const today = new Date();
    const todayStr = today.toLocaleDateString("en-IN");
    const orderDate = order.order_date
      ? new Date(order.order_date).toLocaleDateString("en-IN")
      : "-";

    const companyProfile = await CompanyProfile.findOne({
      where: { is_active: true },
      order: [["is_default", "DESC"], ["id", "ASC"]],
    });

    const safeOrderNo = String(order.order_no || `order-${order.id}`).replace(/[^\w\-]+/g, "_");
    const supportEmail =
      process.env.ORDER_SUPPORT_EMAIL || process.env.SMTP_FROM || process.env.SMTP_USER;

    // ---------- Publisher-wise ----------
    if (publisher_id) {
      const pid = Number(publisher_id);
      if (Number.isNaN(pid)) return reply.code(400).send({ message: "Invalid publisher_id." });

      const itemsForPublisher = items.filter((it) => {
        const b = it.book;
        if (!b) return false;
        const pbid =
          (b.publisher && b.publisher.id) ||
          (b.publisher_id != null ? Number(b.publisher_id) : undefined);
        return pbid === pid;
      });

      if (!itemsForPublisher.length) {
        return reply
          .code(400)
          .send({ message: "No items found for this publisher in this school order." });
      }

      let publisher = await Publisher.findByPk(pid);
      if (!publisher) publisher = itemsForPublisher[0].book.publisher;
      if (!publisher) return reply.code(404).send({ message: "Publisher not found for this order." });

      const toEmail =
        publisher.email || publisher.contact_email || process.env.PUBLISHER_ORDER_FALLBACK_EMAIL;
      if (!toEmail) {
        return reply.code(400).send({
          message:
            "Publisher email not set. Please update publisher master or set PUBLISHER_ORDER_FALLBACK_EMAIL.",
        });
      }

      const subject = `Purchase Order ${order.order_no || order.id} – ${publisher.name}`;

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
              <td style="border:1px solid #ddd;padding:4px;">${b.subject || ""}</td>
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
          Please find below the purchase order from
          <strong>${school?.name || "our client school"}</strong>
          for session <strong>${order.academic_session || "-"}</strong>.
        </p>

        <h3>Order Summary</h3>
        <div><strong>Order No:</strong> ${order.order_no || order.id}</div>
        <div><strong>School:</strong> ${school?.name || "-"}</div>
        <div><strong>Order Date:</strong> ${orderDate}</div>
        <div><strong>Print Date:</strong> ${todayStr}</div>
        <div><strong>Reply To (Query Email):</strong> ${supportEmail || "-"}</div>

        <h3 style="margin-top:16px;">Items</h3>
        <table style="border-collapse:collapse;font-size:12px;">
          <thead>
            <tr>
              <th style="border:1px solid #ddd;padding:4px;">Sr</th>
              <th style="border:1px solid #ddd;padding:4px;">Book</th>
              <th style="border:1px solid #ddd;padding:4px;">Subject</th>
              <th style="border:1px solid #ddd;padding:4px;">Ordered</th>
              <th style="border:1px solid #ddd;padding:4px;">Received</th>
              <th style="border:1px solid #ddd;padding:4px;">Pending</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>

        <p style="margin-top:16px;">
          Regards,<br/>
          EduBridge ERP<br/>
          ${supportEmail ? `Email: ${supportEmail}<br/>` : ""}
        </p>
      `;

      const pdfBuffer = await buildSchoolOrderPdfBuffer({
        order,
        companyProfile,
        items: itemsForPublisher,
        pdfTitle: "PURCHASE ORDER",
        publisherNameForHeader: publisher.name,
        dateStr: todayStr,
        orderDate,
        isPurchaseOrder: true,
      });

      const fileSuffix = `-publisher-${String(publisher.id).replace(/[^\w\-]+/g, "_")}`;
      const filename = `school-order-${safeOrderNo}${fileSuffix}.pdf`;

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
        attachments: [{ filename, content: pdfBuffer, contentType: "application/pdf" }],
      });

      try {
        order.status = "sent";
        if ("email_sent_at" in order) order.email_sent_at = new Date();
        await order.save();
      } catch {}

      return reply.code(200).send({
        message: "Publisher order email (with PDF) sent successfully.",
        order_id: order.id,
        publisher_id: publisher.id,
        to: toEmail,
        message_id: info.messageId,
      });
    }

    // ---------- School email ----------
    if (!school) return reply.code(400).send({ message: "School record not linked with this order." });
    if (!school.email) return reply.code(400).send({ message: "School does not have an email address." });

    const subject = `Book Order ${order.order_no || order.id} – ${school.name}`;
    const plainOrder = order.toJSON();

    const html = `
      <p>Dear ${school.name},</p>
      <p>Please find your book order details below:</p>

      <h3>Order Summary</h3>
      <div><strong>Order No:</strong> ${order.order_no || order.id}</div>
      <div><strong>Session:</strong> ${order.academic_session || "-"}</div>
      <div><strong>Order Date:</strong> ${orderDate}</div>
      <div><strong>Print Date:</strong> ${todayStr}</div>
      <div><strong>Status:</strong> ${order.status}</div>
      ${supportEmail ? `<div><strong>For any query, please write to:</strong> ${supportEmail}</div>` : ""}

      <h3 style="margin-top:18px;">Items</h3>
      <pre style="font-size:11px; background:#f7f7f7; padding:8px; border-radius:4px;">
${JSON.stringify(
  (plainOrder.items || []).map((it) => ({
    title: it.book?.title,
    subject: it.book?.subject,
    publisher: it.book?.publisher?.name,
    ordered_qty: it.total_order_qty,
    received_qty: it.received_qty,
  })),
  null,
  2
)}
      </pre>
    `;

    const pdfBuffer = await buildSchoolOrderPdfBuffer({
      order,
      companyProfile,
      items,
      pdfTitle: "SCHOOL BOOK ORDER",
      publisherNameForHeader: "",
      dateStr: todayStr,
      orderDate,
      isPurchaseOrder: false,
    });

    const filename = `school-order-${safeOrderNo}.pdf`;
    const cc = process.env.ORDER_EMAIL_CC || undefined;

    const info = await sendMail({
      to: school.email,
      cc,
      subject,
      html,
      replyTo: supportEmail || undefined,
      attachments: [{ filename, content: pdfBuffer, contentType: "application/pdf" }],
    });

    try {
      order.status = "sent";
      if ("email_sent_at" in order) order.email_sent_at = new Date();
      await order.save();
    } catch {}

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

/* ============================================
 * GET /api/school-orders/:orderId/pdf
 * ============================================ */
exports.printOrderPdf = async (request, reply) => {
  const { orderId } = request.params;
  const { publisher_id } = request.query || {};

  try {
    const order = await SchoolOrder.findOne({
      where: { id: orderId },
      include: [
        { model: School, as: "school", attributes: ["id", "name", "city"] },
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

    let items = order.items || [];
    let pdfTitle = "SCHOOL BOOK ORDER";
    let publisherNameForHeader = "";
    let isPurchaseOrder = false;

    if (publisher_id) {
      const pid = Number(publisher_id);
      if (!Number.isNaN(pid)) {
        items = items.filter(
          (it) =>
            it.book &&
            (Number(it.book.publisher_id) === pid || Number(it.book.publisher?.id) === pid)
        );

        if (!items.length) {
          return reply.code(400).send({
            error: "NoItems",
            message: "No items found in this order for the selected publisher.",
          });
        }

        publisherNameForHeader =
          items[0].book?.publisher?.name || `Publisher #${pid}`;
        pdfTitle = "PURCHASE ORDER";
        isPurchaseOrder = true;
      }
    }

    const today = new Date();
    const dateStr = today.toLocaleDateString("en-IN");
    const orderDate = order.order_date
      ? new Date(order.order_date).toLocaleDateString("en-IN")
      : "-";

    const safeOrderNo = String(order.order_no || `order-${order.id}`).replace(/[^\w\-]+/g, "_");
    const suffix = publisher_id
      ? `-publisher-${String(publisher_id).replace(/[^\w\-]+/g, "_")}`
      : "";

    const pdfBuffer = await buildSchoolOrderPdfBuffer({
      order,
      companyProfile,
      items,
      pdfTitle,
      publisherNameForHeader,
      dateStr,
      orderDate,
      isPurchaseOrder,
    });

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
