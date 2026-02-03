"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const PDFDocument = require("pdfkit");
const { Op } = require("sequelize");

const {
  sequelize,

  Sale,
  SaleItem,

  Product,
  Book,
  School,
  Distributor,
  Bundle,
  BundleIssue, // ✅ NEW (for distributor ownership check)

  InventoryBatch,
  InventoryTxn,

  CompanyProfile,
  User, // ✅ NEW (for "sold by whom")
} = require("../models");

/* =========================
   Helpers
   ========================= */

const TXN_TYPE = {
  IN: "IN",
  OUT: "OUT",
};

const ADMINISH_ROLES = ["ADMIN", "SUPERADMIN", "OWNER", "STAFF", "ACCOUNTANT"];
const SELLER_ROLES = ["DISTRIBUTOR", ...ADMINISH_ROLES];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round(num(n) * 100) / 100;

const safeText = (v) => String(v ?? "").trim();

function formatDateIN(d) {
  if (!d) return "-";
  try {
    const dt = d instanceof Date ? d : new Date(d);
    const dd = String(dt.getDate()).padStart(2, "0");
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const yy = dt.getFullYear();
    return `${dd}-${mm}-${yy}`;
  } catch {
    return String(d);
  }
}

function nowISODate() {
  return new Date().toISOString().slice(0, 10);
}

function makeSaleNo() {
  return (
    "SL" +
    Math.random()
      .toString(36)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8)
  );
}

function getUserRoles(user) {
  const r = user?.roles ?? user?.role ?? [];
  if (Array.isArray(r)) return r.map((x) => String(x).toUpperCase());
  return [String(r).toUpperCase()];
}

function hasAnyRole(user, roles) {
  const mine = getUserRoles(user);
  return roles.some((r) => mine.includes(String(r).toUpperCase()));
}

function isAdminish(user) {
  const mine = getUserRoles(user);
  return ADMINISH_ROLES.some((r) => mine.includes(r));
}
function isDistributorUser(user) {
  const mine = getUserRoles(user);
  return mine.includes("DISTRIBUTOR");
}
function getDistributorIdFromUser(user) {
  return Number(user?.distributor_id || user?.distributorId || user?.DistributorId || 0) || 0;
}

function enforceSalesAuthorization(user) {
  if (!user) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
  if (!hasAnyRole(user, SELLER_ROLES)) {
    const err = new Error("Not allowed to perform sales");
    err.statusCode = 403;
    throw err;
  }
}

function enforceSaleOwnershipOrAdmin(user, saleRow) {
  if (!saleRow) return;
  if (isAdminish(user)) return;

  // ✅ Distributor can view/cancel/print ONLY own sales
  if (isDistributorUser(user)) {
    if (Number(saleRow.created_by) !== Number(user?.id)) {
      const err = new Error("Not allowed to access this sale");
      err.statusCode = 403;
      throw err;
    }
    return;
  }

  const err = new Error("Not allowed");
  err.statusCode = 403;
  throw err;
}

/** Product type normalize */
function normalizeProductType(p) {
  return String(p?.type || "BOOK").toUpperCase(); // BOOK | MATERIAL
}

/** Product -> Book id resolver */
function resolveBookIdFromProduct(p) {
  if (!p) return 0;
  const direct = num(p.book_id) || num(p.bookId) || num(p.BookId) || 0;
  if (direct) return direct;
  const nested = num(p.book?.id) || 0;
  if (nested) return nested;
  return 0;
}

/** FIFO allocation from available batches */
async function allocateFromBatches({ book_id, qtyNeeded, t, lock }) {
  const batches = await InventoryBatch.findAll({
    where: { book_id, available_qty: { [Op.gt]: 0 } },
    order: [["id", "ASC"]],
    transaction: t,
    lock: lock ? t.LOCK.UPDATE : undefined,
  });

  let remaining = qtyNeeded;
  const allocations = [];

  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(b.available_qty || 0));
    if (take > 0) {
      allocations.push({ batch_id: b.id, qty: take });
      remaining -= take;
    }
  }

  return { allocations, remaining };
}

/* =========================
   Receipt PDF helpers
   ========================= */

function collectPdfBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (d) => chunks.push(d));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

function getCompanyLine(company) {
  const name =
    safeText(company?.company_name) ||
    safeText(company?.name) ||
    safeText(company?.legal_name) ||
    "Company";

  const addr =
    safeText(company?.address) ||
    [company?.address_line1, company?.address_line2, company?.city, company?.state, company?.pincode]
      .filter(Boolean)
      .map(String)
      .join(", ");

  const gst = safeText(company?.gstin || company?.gst_no || company?.gst) || "";
  const phone = safeText(company?.phone || company?.mobile) || "";
  const email = safeText(company?.email) || "";

  return [
    name,
    addr || null,
    gst ? `GSTIN: ${gst}` : null,
    phone ? `Ph: ${phone}` : null,
    email ? `Email: ${email}` : null,
  ].filter(Boolean);
}

function hr(doc) {
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
}

async function generateSaleReceiptPdf({ saleRow, items, customerRow, companyRow, size, soldByUser }) {
  const money = (v) => round2(num(v)).toFixed(2);
  const fmtRs = (v) => `Rs. ${money(v)}`;
  const is3in = String(size || "").toLowerCase() === "3in";

  const doc = is3in ? new PDFDocument({ size: [216, 1000], margin: 12 }) : new PDFDocument({ size: "A5", margin: 24 });

  const companyLines = getCompanyLine(companyRow);

  doc.font("Helvetica-Bold").fontSize(is3in ? 11 : 12).text(companyLines[0] || "Company", { align: "center" });
  doc.font("Helvetica").fontSize(is3in ? 7.5 : 8);
  for (let i = 1; i < companyLines.length; i++) doc.text(companyLines[i], { align: "center" });

  doc.moveDown(0.4);
  doc.font("Helvetica-Bold").fontSize(is3in ? 10 : 11).text("SALE RECEIPT", { align: "center" });
  doc.moveDown(0.4);

  const saleNo = safeText(saleRow.sale_no || saleRow.id);
  const saleDate = formatDateIN(saleRow.sale_date);

  doc.font("Helvetica").fontSize(is3in ? 8.5 : 9);
  doc.text(`Bill No: ${saleNo}`);
  doc.text(`Date: ${saleDate}`);

  const custName =
    safeText(customerRow?.name) ||
    safeText(customerRow?.school_name) ||
    safeText(customerRow?.title) ||
    (String(saleRow.sold_to_type).toUpperCase() === "WALKIN" ? "Walk-in" : `Customer #${saleRow.sold_to_id || "-"}`);

  doc.text(`Customer: ${custName}`);
  if (safeText(saleRow.class_name)) doc.text(`Class: ${safeText(saleRow.class_name)}`);

  // ✅ Sold By
  const soldBy =
    safeText(soldByUser?.name) ||
    safeText(soldByUser?.full_name) ||
    safeText(soldByUser?.username) ||
    safeText(soldByUser?.email) ||
    null;
  if (soldBy) doc.text(`Sold By: ${soldBy}`);

  doc.moveDown(0.4);
  hr(doc);
  doc.moveDown(0.4);

  // ======= FIXED COLUMNS (no continued) =======
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const tableW = right - left;

  const qtyW = is3in ? 26 : 40;
  const amtW = is3in ? 70 : 90;

  const xItem = left;
  const xQty = right - amtW - qtyW;
  const xAmt = right - amtW;

  // Header
  doc.font("Helvetica-Bold").fontSize(is3in ? 8.5 : 9);
  let y = doc.y;
  doc.text("Item", xItem, y, { width: xQty - xItem - 4 });
  doc.text("Qty", xQty, y, { width: qtyW, align: "right" });
  doc.text("Amt", xAmt, y, { width: amtW, align: "right" });

  doc.moveDown(0.35);
  doc.font("Helvetica").fontSize(is3in ? 8.5 : 9);

  // Rows
  for (const it of items) {
    const title = safeText(it.title_snapshot || "Item");
    const qty = num(it.issued_qty || it.qty || 0);
    const amt = num(it.amount || 0);

    y = doc.y;

    // Item may wrap; keep columns aligned by writing qty/amt at same y
    doc.text(title, xItem, y, { width: xQty - xItem - 4 });
    doc.text(String(qty), xQty, y, { width: qtyW, align: "right" });
    doc.text(fmtRs(amt), xAmt, y, { width: amtW, align: "right" });

    // If item wrapped into multiple lines, jump to the max y (pdfkit already advanced y via first text)
    doc.moveDown(0.15);
  }

  doc.moveDown(0.3);
  hr(doc);
  doc.moveDown(0.35);

  doc.font("Helvetica-Bold").fontSize(is3in ? 9.5 : 10);
  doc.text(`Total: ${fmtRs(saleRow.total_amount)}`, { align: "right" });

  doc.font("Helvetica").fontSize(is3in ? 8.5 : 9);
  doc.text(`Paid: ${fmtRs(saleRow.paid_amount)}`, { align: "right" });
  doc.text(`Balance: ${fmtRs(saleRow.balance_amount)}`, { align: "right" });

  if (safeText(saleRow.payment_mode)) doc.text(`Mode: ${safeText(saleRow.payment_mode)}`, { align: "right" });

  if (safeText(saleRow.notes)) {
    doc.moveDown(0.4);
    doc.font("Helvetica-Bold").fontSize(is3in ? 8.5 : 9).text("Notes:");
    doc.font("Helvetica").fontSize(is3in ? 8.5 : 9).text(safeText(saleRow.notes));
  }

  doc.moveDown(0.8);
  doc.font("Helvetica").fontSize(is3in ? 8 : 8).text("Thank you!", { align: "center" });

  return collectPdfBuffer(doc);
}

/* =========================
   Controller
   ========================= */

/**
 * POST /api/sales
 * ✅ Distributor can sell ONLY bundles issued to him (if bundle_id provided)
 * ✅ Record seller: created_by (already) + return seller info
 */
exports.create = async (request, reply) => {
  try {
    enforceSalesAuthorization(request.user);
  } catch (e) {
    return reply.code(e.statusCode || 403).send({ message: e.message });
  }

  const body = request.body || {};

  const sold_to_type = safeText(body.sold_to_type || "WALKIN").toUpperCase();
  const sold_to_id = body.sold_to_id != null ? num(body.sold_to_id) : null;

  const bundle_id = body.bundle_id != null ? num(body.bundle_id) : null;
  const class_name = body.class_name != null ? safeText(body.class_name) : null;

  const payment_mode = safeText(body.payment_mode || "CASH").toUpperCase();
  const paid_amount_in = round2(num(body.paid_amount));

  const notes = body.notes != null ? String(body.notes).trim() : null;

  if (!["SCHOOL", "WALKIN", "DISTRIBUTOR"].includes(sold_to_type)) {
    return reply.code(400).send({ message: "sold_to_type must be SCHOOL, WALKIN, or DISTRIBUTOR" });
  }
  if (sold_to_type !== "WALKIN" && !sold_to_id) {
    return reply.code(400).send({ message: "sold_to_id is required for SCHOOL/DISTRIBUTOR" });
  }

  const itemsIn = Array.isArray(body.items) ? body.items : [];
  if (!itemsIn.length) return reply.code(400).send({ message: "items is required (array)" });

  const want = itemsIn
    .map((x) => ({
      product_id: num(x.product_id || x.productId || x.id),
      qty: Math.max(0, num(x.qty)),
      unit_price: Math.max(0, num(x.unit_price ?? x.unitPrice ?? x.price)),
      include: x.include !== false,
    }))
    .filter((x) => x.product_id > 0 && x.qty > 0 && x.include);

  if (!want.length) return reply.code(400).send({ message: "No valid items. Provide product_id and qty > 0." });

  const t = await sequelize.transaction();
  try {
    // validate customer
    let customerRow = null;
    if (sold_to_type === "SCHOOL") {
      customerRow = await School.findByPk(sold_to_id, { transaction: t });
      if (!customerRow) {
        await t.rollback();
        return reply.code(404).send({ message: "School not found" });
      }
    } else if (sold_to_type === "DISTRIBUTOR") {
      customerRow = await Distributor.findByPk(sold_to_id, { transaction: t });
      if (!customerRow) {
        await t.rollback();
        return reply.code(404).send({ message: "Distributor not found" });
      }
    }

    // optional bundle validate + distributor ownership
    if (bundle_id) {
      const b = await Bundle.findByPk(bundle_id, { transaction: t }).catch(() => null);
      if (!b) {
        await t.rollback();
        return reply.code(404).send({ message: "bundle_id is invalid (bundle not found)" });
      }

      // ✅ Distributor can sell ONLY bundles issued to him
      if (isDistributorUser(request.user) && !isAdminish(request.user)) {
        const myDid = getDistributorIdFromUser(request.user);
        if (!myDid) {
          await t.rollback();
          return reply.code(403).send({ message: "Distributor user not linked with distributor_id" });
        }

        const issued = await BundleIssue.findOne({
          where: {
            bundle_id,
            issued_to_type: "DISTRIBUTOR",
            issued_to_id: myDid,
            status: "ISSUED",
          },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });

        if (!issued) {
          await t.rollback();
          return reply.code(403).send({ message: "This bundle is not issued to you. You cannot sell it." });
        }
      }
    }

    // load products
    const productIds = want.map((x) => x.product_id);
    const products = await Product.findAll({
      where: { id: productIds },
      include: Product?.associations?.book ? [{ association: Product.associations.book, required: false }] : [],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    const pMap = new Map(products.map((p) => [num(p.id), p]));
    const missing = want.filter((x) => !pMap.get(x.product_id)).map((x) => x.product_id);
    if (missing.length) {
      await t.rollback();
      return reply.code(400).send({ message: "Some products not found", missing });
    }

    // create sale_no
    let sale_no = makeSaleNo();
    for (let i = 0; i < 5; i++) {
      const exists = await Sale.findOne({ where: { sale_no }, transaction: t });
      if (!exists) break;
      sale_no = makeSaleNo();
    }

    const outTxns = [];
    const saleItemsToCreate = [];
    const shortages = [];

    let subtotal = 0;

    for (const line of want) {
      const p = pMap.get(line.product_id);
      const kind = normalizeProductType(p) === "BOOK" ? "BOOK" : "MATERIAL";
      const book_id = kind === "BOOK" ? resolveBookIdFromProduct(p) : null;

      const title_snapshot =
        safeText(p?.book?.title) || safeText(p?.name) || safeText(p?.title) || (kind === "BOOK" ? "Book" : "Item");

      const class_name_snapshot = safeText(p?.book?.class_name) || safeText(p?.class_name) || null;

      const qty = round2(line.qty);
      const unit_price = round2(line.unit_price);

      let issued_qty = qty;
      let short_qty = 0;

      if (kind === "BOOK") {
        if (!book_id) {
          await t.rollback();
          return reply.code(400).send({
            message: "Some BOOK products are not linked to book_id (cannot deduct inventory). Fix Product.book_id mapping.",
            product_id: line.product_id,
            title: title_snapshot,
          });
        }

        const { allocations } = await allocateFromBatches({ book_id, qtyNeeded: qty, t, lock: true });

        const issuedNow = round2(allocations.reduce((s, a) => s + num(a.qty), 0));
        issued_qty = issuedNow;
        short_qty = round2(Math.max(0, qty - issuedNow));

        for (const a of allocations) {
          outTxns.push({
            txn_type: TXN_TYPE.OUT,
            book_id: num(book_id),
            batch_id: num(a.batch_id),
            qty: num(a.qty),
            ref_type: "SALE",
            ref_id: 0,
            notes: `Sale ${sale_no} -> product ${line.product_id} (${title_snapshot})`,
          });
        }

        for (const a of allocations) {
          await InventoryBatch.update(
            { available_qty: sequelize.literal(`available_qty - ${num(a.qty)}`) },
            { where: { id: num(a.batch_id) }, transaction: t }
          );
        }

        if (short_qty > 0) {
          shortages.push({
            product_id: line.product_id,
            book_id: num(book_id),
            title: title_snapshot,
            requested: qty,
            issued: issued_qty,
            short: short_qty,
          });
        }
      }

      const amount = round2(num(issued_qty) * num(unit_price));
      subtotal = round2(subtotal + amount);

      saleItemsToCreate.push({
        sale_id: 0,
        product_id: num(line.product_id),
        book_id: kind === "BOOK" ? num(book_id) : null,
        kind,
        title_snapshot,
        class_name_snapshot,
        qty,
        unit_price,
        amount,
        issued_qty,
        short_qty,
      });
    }

    const discount = round2(num(body.discount));
    const tax = round2(num(body.tax));

    const total_amount = round2(Math.max(0, subtotal - discount + tax));
    const paid_amount = round2(Math.min(total_amount, Math.max(0, paid_amount_in)));
    const balance_amount = round2(Math.max(0, total_amount - paid_amount));

    const sale = await Sale.create(
      {
        sale_no,
        sale_date: safeText(body.sale_date) || nowISODate(),
        sold_to_type,
        sold_to_id: sold_to_type === "WALKIN" ? null : sold_to_id,
        bundle_id: bundle_id || null,
        class_name: class_name || null,
        status: "COMPLETED",
        subtotal,
        discount,
        tax,
        total_amount,
        payment_mode,
        paid_amount,
        balance_amount,
        notes,
        created_by: request.user?.id || null,
      },
      { transaction: t }
    );

    for (const si of saleItemsToCreate) si.sale_id = sale.id;
    for (const tx of outTxns) tx.ref_id = sale.id;

    if (saleItemsToCreate.length) await SaleItem.bulkCreate(saleItemsToCreate, { transaction: t });
    if (outTxns.length) await InventoryTxn.bulkCreate(outTxns, { transaction: t });

    await t.commit();

    const soldByUser = User && sale.created_by ? await User.findByPk(sale.created_by).catch(() => null) : null;

    return reply.send({
      message: shortages.length ? "Sale saved (partial stock for some items)" : "Sale saved successfully",
      sale_id: sale.id,
      sale_no: sale.sale_no,
      sold_by: soldByUser
        ? {
            id: soldByUser.id,
            name: soldByUser.name || soldByUser.full_name || null,
            username: soldByUser.username || null,
            email: soldByUser.email || null,
            role: soldByUser.role || null,
          }
        : null,
      totals: { subtotal, discount, tax, total_amount, paid_amount, balance_amount },
      shortages,
    });
  } catch (err) {
    request.log.error({ err }, "sale create failed");
    await t.rollback();
    return reply.code(500).send({ message: err?.message || "Internal Server Error" });
  }
};

/**
 * GET /api/sales/:id
 * ✅ Distributor can view only own sale
 * ✅ returns sold_by user
 */
exports.getOne = async (request, reply) => {
  const id = num(request.params?.id);
  if (!id) return reply.code(400).send({ message: "Invalid id" });

  try {
    const row = await Sale.findByPk(id, {
      include: [
        { model: SaleItem, as: "items", required: false },
        Bundle ? { model: Bundle, as: "bundle", required: false } : null,
        User ? { model: User, as: "creator", required: false } : null,
      ].filter(Boolean),
      order: [[{ model: SaleItem, as: "items" }, "id", "ASC"]],
    });

    if (!row) return reply.code(404).send({ message: "Sale not found" });

    try {
      enforceSaleOwnershipOrAdmin(request.user, row);
    } catch (e) {
      return reply.code(e.statusCode || 403).send({ message: e.message });
    }

    let customer = null;
    if (String(row.sold_to_type).toUpperCase() === "SCHOOL" && row.sold_to_id) {
      customer = await School.findByPk(row.sold_to_id).catch(() => null);
    } else if (String(row.sold_to_type).toUpperCase() === "DISTRIBUTOR" && row.sold_to_id) {
      customer = await Distributor.findByPk(row.sold_to_id).catch(() => null);
    }

    const soldByUser = User && row.created_by ? await User.findByPk(row.created_by).catch(() => null) : null;

    return reply.send({
      sale: row,
      customer,
      sold_by: soldByUser
        ? {
            id: soldByUser.id,
            name: soldByUser.name || soldByUser.full_name || null,
            username: soldByUser.username || null,
            email: soldByUser.email || null,
            role: soldByUser.role || null,
          }
        : null,
    });
  } catch (err) {
    request.log.error({ err }, "sale getOne failed");
    return reply.code(500).send({ message: err?.message || "Internal Server Error" });
  }
};

/**
 * GET /api/sales
 * ✅ Distributor sees only own sales
 */
exports.list = async (request, reply) => {
  try {
    const q = request.query || {};
    const limit = Math.min(500, Math.max(1, num(q.limit) || 200));

    const where = {};

    if (q.status) where.status = safeText(q.status).toUpperCase();
    if (q.sold_to_type) where.sold_to_type = safeText(q.sold_to_type).toUpperCase();
    if (q.sold_to_id) where.sold_to_id = num(q.sold_to_id);

    if (q.date_from || q.date_to) {
      where.sale_date = {};
      if (q.date_from) where.sale_date[Op.gte] = safeText(q.date_from);
      if (q.date_to) where.sale_date[Op.lte] = safeText(q.date_to);
    }

    if (!isAdminish(request.user) && isDistributorUser(request.user)) {
      where.created_by = num(request.user?.id);
    }

    const rows = await Sale.findAll({
      where,
      order: [["id", "DESC"]],
      limit,
    });

    return reply.send({ rows });
  } catch (err) {
    request.log.error({ err }, "sale list failed");
    return reply.code(500).send({ message: err?.message || "Internal Server Error" });
  }
};

/**
 * GET /api/sales/:id/receipt?size=a5|3in
 * ✅ Distributor can print only own sale
 * ✅ prints Sold By
 */
exports.receiptPdf = async (request, reply) => {
  const id = num(request.params?.id);
  if (!id) return reply.code(400).send({ message: "Invalid id" });

  try {
    const sale = await Sale.findByPk(id, {
      include: [{ model: SaleItem, as: "items", required: false }],
      order: [[{ model: SaleItem, as: "items" }, "id", "ASC"]],
    });

    if (!sale) return reply.code(404).send({ message: "Sale not found" });

    try {
      enforceSaleOwnershipOrAdmin(request.user, sale);
    } catch (e) {
      return reply.code(e.statusCode || 403).send({ message: e.message });
    }

    let companyRow = null;
    if (CompanyProfile && CompanyProfile.findOne) {
      companyRow = await CompanyProfile.findOne({ order: [["id", "DESC"]] }).catch(() => null);
    }

    let customerRow = null;
    if (String(sale.sold_to_type).toUpperCase() === "SCHOOL" && sale.sold_to_id) {
      customerRow = await School.findByPk(sale.sold_to_id).catch(() => null);
    } else if (String(sale.sold_to_type).toUpperCase() === "DISTRIBUTOR" && sale.sold_to_id) {
      customerRow = await Distributor.findByPk(sale.sold_to_id).catch(() => null);
    }

    const soldByUser = User && sale.created_by ? await User.findByPk(sale.created_by).catch(() => null) : null;

    const size = request.query?.size ? String(request.query.size).trim() : "a5";

    const pdfBuffer = await generateSaleReceiptPdf({
      saleRow: sale,
      items: sale.items || [],
      customerRow,
      companyRow,
      size,
      soldByUser,
    });

    const fileName = `sale_${safeText(sale.sale_no || sale.id)}.pdf`;
    reply.header("Content-Type", "application/pdf").header("Content-Disposition", `inline; filename="${fileName}"`);
    return reply.send(pdfBuffer);
  } catch (err) {
    request.log.error({ err }, "sale receiptPdf failed");
    return reply.code(500).send({ message: err?.message || "Internal Server Error" });
  }
};

/**
 * POST /api/sales/:id/cancel
 * ✅ Distributor can cancel only own sale
 */
exports.cancel = async (request, reply) => {
  try {
    enforceSalesAuthorization(request.user);
  } catch (e) {
    return reply.code(e.statusCode || 403).send({ message: e.message });
  }

  const id = num(request.params?.id);
  if (!id) return reply.code(400).send({ message: "Invalid id" });

  const t = await sequelize.transaction();
  try {
    const sale = await Sale.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!sale) {
      await t.rollback();
      return reply.code(404).send({ message: "Sale not found" });
    }

    try {
      enforceSaleOwnershipOrAdmin(request.user, sale);
    } catch (e) {
      await t.rollback();
      return reply.code(e.statusCode || 403).send({ message: e.message });
    }

    if (String(sale.status).toUpperCase() === "CANCELLED") {
      await t.rollback();
      return reply.code(400).send({ message: "Sale already CANCELLED" });
    }

    const outTxns = await InventoryTxn.findAll({
      where: { ref_type: "SALE", ref_id: sale.id, txn_type: TXN_TYPE.OUT },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    const byBatch = new Map();
    for (const tx of outTxns) {
      const batchId = num(tx.batch_id);
      const q = num(tx.qty);
      if (batchId && q > 0) byBatch.set(batchId, (byBatch.get(batchId) || 0) + q);
    }

    for (const [batch_id, qtyAdd] of byBatch.entries()) {
      await InventoryBatch.update(
        { available_qty: sequelize.literal(`available_qty + ${qtyAdd}`) },
        { where: { id: batch_id }, transaction: t }
      );
    }

    if (byBatch.size) {
      const inTxns = [];
      for (const [batch_id, qtyAdd] of byBatch.entries()) {
        const any = outTxns.find((x) => num(x.batch_id) === num(batch_id));
        inTxns.push({
          txn_type: TXN_TYPE.IN,
          book_id: num(any?.book_id),
          batch_id: num(batch_id),
          qty: qtyAdd,
          ref_type: "SALE_CANCEL",
          ref_id: sale.id,
          notes: `Cancel sale ${sale.sale_no || sale.id} -> stock revert`,
        });
      }
      await InventoryTxn.bulkCreate(inTxns, { transaction: t });
    }

    await sale.update(
      {
        status: "CANCELLED",
        cancelled_at: new Date(),
        cancelled_by: request.user?.id || null,
      },
      { transaction: t }
    );

    await t.commit();

    return reply.send({
      message: byBatch.size ? "Sale cancelled (stock reverted)" : "Sale cancelled (no stock was deducted)",
      sale_id: sale.id,
      sale_no: sale.sale_no,
      reverted: { batches: Array.from(byBatch.entries()).map(([batch_id, qty]) => ({ batch_id, qty })) },
    });
  } catch (err) {
    request.log.error({ err }, "sale cancel failed");
    await t.rollback();
    return reply.code(500).send({ message: err?.message || "Internal Server Error" });
  }
};
