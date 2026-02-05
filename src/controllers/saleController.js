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
  BundleIssue, // ✅ distributor ownership check

  InventoryBatch,
  InventoryTxn,

  CompanyProfile,
  User, // ✅ sold-by
} = require("../models");

/* =========================
   Helpers
   ========================= */

const TXN_TYPE = { IN: "IN", OUT: "OUT" };

const ADMINISH_ROLES = ["ADMIN", "SUPERADMIN", "OWNER", "STAFF", "ACCOUNTANT"];
const SELLER_ROLES = ["DISTRIBUTOR", ...ADMINISH_ROLES];

/**
 * ✅ Robust number parser
 * Handles DECIMAL strings, commas, currency symbols.
 */
const num = (v) => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^\d.-]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
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

/**
 * ✅ UPDATED:
 * - Customer line shows Student (bill_to_name) if present
 * - If sold_to_type=SCHOOL and bill_to_name exists, show School on next line
 * - If payment_mode=CREDIT show Parent/Phone/Ref fields
 * - Item Qty printed from requested_qty, Amount from amount or computed
 */
async function generateSaleReceiptPdf({ saleRow, items, customerRow, companyRow, size, soldByUser }) {
  const money = (v) => round2(num(v)).toFixed(2);
  const fmtRs = (v) => `Rs. ${money(v)}`;
  const is3in = String(size || "").toLowerCase() === "3in";

  const doc = is3in
    ? new PDFDocument({ size: [216, 1000], margin: 12 })
    : new PDFDocument({ size: "A5", margin: 24 });

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

  const soldType = String(saleRow.sold_to_type || "").toUpperCase();
  const baseCustomer =
    safeText(customerRow?.name) ||
    safeText(customerRow?.school_name) ||
    safeText(customerRow?.title) ||
    (soldType === "WALKIN" ? "Walk-in" : `Customer #${saleRow.sold_to_id || "-"}`);

  const billToName = safeText(saleRow.bill_to_name) || "";
  doc.text(`Customer: ${billToName || baseCustomer}`);

  if (billToName && soldType === "SCHOOL" && safeText(baseCustomer)) {
    doc.text(`School: ${baseCustomer}`);
  }

  if (safeText(saleRow.class_name)) doc.text(`Class: ${safeText(saleRow.class_name)}`);

  // Credit-only details
  const mode = safeText(saleRow.payment_mode).toUpperCase();
  if (mode === "CREDIT") {
    if (safeText(saleRow.parent_name)) doc.text(`Parent: ${safeText(saleRow.parent_name)}`);
    if (safeText(saleRow.phone)) doc.text(`Phone: ${safeText(saleRow.phone)}`);

    if (safeText(saleRow.reference_by)) {
      const rp = safeText(saleRow.reference_phone);
      doc.text(`Ref: ${safeText(saleRow.reference_by)}${rp ? ` • ${rp}` : ""}`);
    }
  }

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

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;

  const qtyW = is3in ? 26 : 40;
  const amtW = is3in ? 70 : 90;

  const xItem = left;
  const xQty = right - amtW - qtyW;
  const xAmt = right - amtW;

  doc.font("Helvetica-Bold").fontSize(is3in ? 8.5 : 9);
  const y = doc.y;
  doc.text("Item", xItem, y, { width: xQty - xItem - 4 });
  doc.text("Qty", xQty, y, { width: qtyW, align: "right" });
  doc.text("Amt", xAmt, y, { width: amtW, align: "right" });

  doc.moveDown(0.35);
  doc.font("Helvetica").fontSize(is3in ? 8.5 : 9);

  const safeItems = Array.isArray(items)
    ? items.map((it) => (it && typeof it.toJSON === "function" ? it.toJSON() : (it?.dataValues ?? it)))
    : [];

  for (const it of safeItems) {
    const title = safeText(it.title_snapshot || it.name_snapshot || it.title || it.name || "Item");

    // ✅ PRINT requested qty (billing)
    const qty = num(it.requested_qty ?? it.requestedQty ?? it.qty ?? it.quantity ?? 0);

    // ✅ billing price
    const unit = num(
      it.requested_unit_price ??
        it.requestedUnitPrice ??
        it.unit_price ??
        it.unitPrice ??
        it.price ??
        it.selling_price ??
        it.sellingPrice ??
        it.sale_price ??
        it.salePrice ??
        it.rate ??
        it.mrp ??
        0
    );

    // ✅ prefer stored amount; else compute from requested
    let amt = num(it.amount ?? it.line_amount ?? it.lineAmount ?? it.line_total ?? it.lineTotal ?? it.total ?? 0);
    if (amt <= 0 && qty > 0 && unit > 0) amt = round2(qty * unit);

    const rowY = doc.y;
    const rowH = is3in ? 11 : 12;

    doc.text(title, xItem, rowY, {
      width: xQty - xItem - 4,
      ellipsis: true,
      lineBreak: false,
    });

    doc.text(String(qty), xQty, rowY, { width: qtyW, align: "right" });
    doc.text(fmtRs(amt > 0 ? amt : 0), xAmt, rowY, { width: amtW, align: "right" });

    doc.y = rowY + rowH;
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
 * ✅ Added:
 * - bill_to_name always required
 * - parent_name/phone required only when payment_mode=CREDIT (udhaaar)
 * - reference_by/reference_phone optional only for credit
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

  // ✅ NEW: bill-to / credit-only details
  const bill_to_name = body.bill_to_name != null ? safeText(body.bill_to_name) : "";
  const parent_name = body.parent_name != null ? safeText(body.parent_name) : "";
  const phone = body.phone != null ? safeText(body.phone) : "";
  const reference_by = body.reference_by != null ? safeText(body.reference_by) : "";
  const reference_phone = body.reference_phone != null ? safeText(body.reference_phone) : "";

  const isCredit = payment_mode === "CREDIT";

  if (!["SCHOOL", "WALKIN", "DISTRIBUTOR"].includes(sold_to_type)) {
    return reply.code(400).send({ message: "sold_to_type must be SCHOOL, WALKIN, or DISTRIBUTOR" });
  }
  if (sold_to_type !== "WALKIN" && !sold_to_id) {
    return reply.code(400).send({ message: "sold_to_id is required for SCHOOL/DISTRIBUTOR" });
  }

  if (!["CASH", "UPI", "CARD", "CREDIT", "MIXED"].includes(payment_mode)) {
    return reply.code(400).send({ message: "payment_mode must be CASH, UPI, CARD, CREDIT, MIXED" });
  }

  // ✅ Student name always required
  if (!bill_to_name) {
    return reply.code(400).send({ message: "Student name is required (bill_to_name)" });
  }

  // ✅ Credit (udhaaar) requires extra details
  if (isCredit) {
    if (!parent_name) return reply.code(400).send({ message: "Parent name is required for CREDIT sale" });
    if (!phone) return reply.code(400).send({ message: "Phone is required for CREDIT sale" });
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

      // ✅ requested from frontend
      const requested_qty = round2(line.qty);
      const requested_unit_price = round2(line.unit_price);

      // default: issued == requested
      let issued_qty = requested_qty;
      let short_qty = 0;

      if (kind === "BOOK") {
        // ✅ books must be whole numbers (optional but recommended)
        if (requested_qty % 1 !== 0) {
          await t.rollback();
          return reply.code(400).send({
            message: "Book quantity must be whole number",
            product_id: line.product_id,
            qty: requested_qty,
          });
        }

        if (!book_id) {
          await t.rollback();
          return reply.code(400).send({
            message: "Some BOOK products are not linked to book_id (cannot deduct inventory). Fix Product.book_id mapping.",
            product_id: line.product_id,
            title: title_snapshot,
          });
        }

        const { allocations } = await allocateFromBatches({ book_id, qtyNeeded: requested_qty, t, lock: true });

        const issuedNow = round2(allocations.reduce((s, a) => s + num(a.qty), 0));
        issued_qty = issuedNow;
        short_qty = round2(Math.max(0, requested_qty - issuedNow));

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
          const q = Number(num(a.qty));
          await InventoryBatch.update(
            { available_qty: sequelize.literal(`available_qty - ${q}`) },
            { where: { id: num(a.batch_id) }, transaction: t }
          );
        }

        if (short_qty > 0) {
          shortages.push({
            product_id: line.product_id,
            book_id: num(book_id),
            title: title_snapshot,
            requested: requested_qty,
            issued: issued_qty,
            short: short_qty,
          });
        }
      }

      // ✅ billed on requested, not issued
      const billed_amount = round2(num(requested_qty) * num(requested_unit_price));
      subtotal = round2(subtotal + billed_amount);

      saleItemsToCreate.push({
        sale_id: 0,
        product_id: num(line.product_id),
        book_id: kind === "BOOK" ? num(book_id) : null,
        kind,
        title_snapshot,
        class_name_snapshot,

        requested_qty,
        requested_unit_price,

        qty: requested_qty,
        unit_price: requested_unit_price,

        amount: billed_amount,

        issued_qty,
        short_qty,
      });
    }

    const discount = round2(num(body.discount));
    const tax = round2(num(body.tax));

    const total_amount = round2(Math.max(0, subtotal - discount + tax));

    // ✅ If CREDIT, paid can be less than total (balance will be >0)
    // For CASH/UPI/CARD, we still clamp paid to total
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

        // ✅ NEW fields
        bill_to_name,
        parent_name: isCredit ? parent_name : null,
        phone: isCredit ? phone : null,
        reference_by: isCredit ? reference_by : null,
        reference_phone: isCredit ? reference_phone : null,

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
 */
exports.getOne = async (request, reply) => {
  const id = num(request.params?.id);
  if (!id) return reply.code(400).send({ message: "Invalid id" });

  try {
    const row = await Sale.findByPk(id);
    if (!row) return reply.code(404).send({ message: "Sale not found" });

    try {
      enforceSaleOwnershipOrAdmin(request.user, row);
    } catch (e) {
      return reply.code(e.statusCode || 403).send({ message: e.message });
    }

    const items = await SaleItem.findAll({ where: { sale_id: id }, order: [["id", "ASC"]] });

    let customer = null;
    if (String(row.sold_to_type).toUpperCase() === "SCHOOL" && row.sold_to_id) {
      customer = await School.findByPk(row.sold_to_id).catch(() => null);
    } else if (String(row.sold_to_type).toUpperCase() === "DISTRIBUTOR" && row.sold_to_id) {
      customer = await Distributor.findByPk(row.sold_to_id).catch(() => null);
    }

    const soldByUser = User && row.created_by ? await User.findByPk(row.created_by).catch(() => null) : null;

    return reply.send({
      sale: { ...row.toJSON(), items },
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
 */
exports.list = async (request, reply) => {
  try {
    const q = request.query || {};
    const limit = Math.min(500, Math.max(1, num(q.limit) || 200));
    const where = {};

    if (q.status) where.status = safeText(q.status).toUpperCase();
    if (q.sold_to_type) where.sold_to_type = safeText(q.sold_to_type).toUpperCase();
    if (q.sold_to_id) where.sold_to_id = num(q.sold_to_id);

    if (q.payment_mode) where.payment_mode = safeText(q.payment_mode).toUpperCase(); // ✅ NEW filter

    if (q.date_from || q.date_to) {
      where.sale_date = {};
      if (q.date_from) where.sale_date[Op.gte] = safeText(q.date_from);
      if (q.date_to) where.sale_date[Op.lte] = safeText(q.date_to);
    }

    if (!isAdminish(request.user) && isDistributorUser(request.user)) {
      where.created_by = num(request.user?.id);
    }

    const rows = await Sale.findAll({ where, order: [["id", "DESC"]], limit });
    return reply.send({ rows });
  } catch (err) {
    request.log.error({ err }, "sale list failed");
    return reply.code(500).send({ message: err?.message || "Internal Server Error" });
  }
};

/**
 * GET /api/sales/:id/receipt?size=a5|3in
 */
exports.receiptPdf = async (request, reply) => {
  const id = num(request.params?.id);
  if (!id) return reply.code(400).send({ message: "Invalid id" });

  try {
    const sale = await Sale.findByPk(id);
    if (!sale) return reply.code(404).send({ message: "Sale not found" });

    try {
      enforceSaleOwnershipOrAdmin(request.user, sale);
    } catch (e) {
      return reply.code(e.statusCode || 403).send({ message: e.message });
    }

    const items = await SaleItem.findAll({ where: { sale_id: id }, order: [["id", "ASC"]] });

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
      items,
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
/**
 * GET /api/sales/my/summary?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
 * ✅ Distributor: only his own (created_by=user.id)
 * ✅ Admin: can see overall; optional filters: created_by, sold_to_type, sold_to_id
 *
 * Returns:
 * - totals by payment_mode (CASH/UPI/CARD/CREDIT/MIXED)
 * - total_sales_amount, total_paid, total_balance
 * - count of bills
 */
exports.mySummary = async (request, reply) => {
  try {
    enforceSalesAuthorization(request.user);
  } catch (e) {
    return reply.code(e.statusCode || 403).send({ message: e.message });
  }

  const q = request.query || {};

  const date_from = q.date_from ? safeText(q.date_from) : null;
  const date_to = q.date_to ? safeText(q.date_to) : null;

  // Default: today (if no dates supplied)
  const df = date_from || nowISODate();
  const dt = date_to || nowISODate();

  const where = {
    status: "COMPLETED",
    sale_date: { [Op.gte]: df, [Op.lte]: dt },
  };

  // ✅ Distributor restriction (only own)
  if (!isAdminish(request.user) && isDistributorUser(request.user)) {
    where.created_by = num(request.user?.id);
  } else {
    // ✅ Admin optional filters
    if (q.created_by) where.created_by = num(q.created_by);
    if (q.sold_to_type) where.sold_to_type = safeText(q.sold_to_type).toUpperCase();
    if (q.sold_to_id) where.sold_to_id = num(q.sold_to_id);
  }

  try {
    // We can aggregate using Sequelize.fn
    const rows = await Sale.findAll({
      where,
      attributes: [
        "payment_mode",
        [sequelize.fn("COUNT", sequelize.col("id")), "bills"],
        [sequelize.fn("SUM", sequelize.col("total_amount")), "total_sales_amount"],
        [sequelize.fn("SUM", sequelize.col("paid_amount")), "total_paid_amount"],
        [sequelize.fn("SUM", sequelize.col("balance_amount")), "total_balance_amount"],
      ],
      group: ["payment_mode"],
      raw: true,
    });

    const base = {
      date_from: df,
      date_to: dt,
      totals: {
        CASH: { bills: 0, sale: 0, paid: 0, balance: 0 },
        UPI: { bills: 0, sale: 0, paid: 0, balance: 0 },
        CARD: { bills: 0, sale: 0, paid: 0, balance: 0 },
        CREDIT: { bills: 0, sale: 0, paid: 0, balance: 0 },
        MIXED: { bills: 0, sale: 0, paid: 0, balance: 0 },
      },
      grand: { bills: 0, sale: 0, paid: 0, balance: 0 },
    };

    for (const r of rows) {
      const mode = safeText(r.payment_mode).toUpperCase();
      if (!base.totals[mode]) base.totals[mode] = { bills: 0, sale: 0, paid: 0, balance: 0 };

      const bills = num(r.bills);
      const sale = round2(num(r.total_sales_amount));
      const paid = round2(num(r.total_paid_amount));
      const balance = round2(num(r.total_balance_amount));

      base.totals[mode] = { bills, sale, paid, balance };

      base.grand.bills += bills;
      base.grand.sale = round2(base.grand.sale + sale);
      base.grand.paid = round2(base.grand.paid + paid);
      base.grand.balance = round2(base.grand.balance + balance);
    }

    return reply.send(base);
  } catch (err) {
    request.log.error({ err }, "sale mySummary failed");
    return reply.code(500).send({ message: err?.message || "Internal Server Error" });
  }
};
