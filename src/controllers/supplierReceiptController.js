"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const PDFDocument = require("pdfkit");

const { Op } = require("sequelize");
const {
  sequelize,
  Supplier,
  Book,
  InventoryBatch,
  InventoryTxn,
  SupplierReceipt,
  SupplierReceiptItem,
  SupplierLedgerTxn,
  CompanyProfile,

  // Optional (if exists)
  SchoolOrderItem,

  // ✅ NEW (optional but recommended for School return + PDF)
  School,
  SchoolOrder,
} = require("../models");

/* ============================================================
 * Helpers
 * ============================================================ */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n) => Math.round(num(n) * 100) / 100;

function now() {
  return new Date();
}

const safeText = (v) => String(v ?? "").trim();

// ✅ Money formatting (₹)
const money = (v) => {
  const n = round2(v);
  return `₹ ${n.toFixed(2)}`;
};

const formatDateIN = (d) => {
  if (!d) return "-";
  try {
    return new Date(d).toLocaleDateString("en-IN");
  } catch {
    return "-";
  }
};

async function makeReceiptNo(t) {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");

  const last = await SupplierReceipt.findOne({
    order: [["id", "DESC"]],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

  const lastSeq = last && last.receipt_no ? String(last.receipt_no).split("-").pop() : "0";
  const seq = String(num(lastSeq) + 1).padStart(6, "0");
  return `SR-${yyyy}-${mm}-${seq}`;
}

/**
 * NOTE:
 * - We keep legacy logic for discount:
 *   - PERCENT => % of gross line
 *   - AMOUNT  => line discount amount (NOT per-unit)
 */
function calcItemLine({ qty, rate, discType, discVal }) {
  const q = Math.max(0, Math.floor(num(qty)));
  const r = Math.max(0, num(rate));

  const gross = round2(q * r);

  let discount = 0;
  const t = String(discType || "NONE").toUpperCase();
  const v = num(discVal);

  if (t === "PERCENT") {
    discount = round2(gross * (Math.max(0, v) / 100));
  } else if (t === "AMOUNT") {
    discount = round2(Math.max(0, v));
  }

  if (discount > gross) discount = gross;
  const net = round2(gross - discount);

  return {
    qty: q,
    rate: round2(r),
    gross_amount: gross,
    discount_amount: discount,
    net_amount: net,
  };
}

function calcHeaderTotals({
  itemsNetSum,
  billDiscountType,
  billDiscountValue,
  shipping_charge,
  other_charge,
  round_off,
}) {
  const sub_total = round2(itemsNetSum);

  const t = String(billDiscountType || "NONE").toUpperCase();
  const v = num(billDiscountValue);

  let bill_discount_amount = 0;
  if (t === "PERCENT") {
    bill_discount_amount = round2(sub_total * (Math.max(0, v) / 100));
  } else if (t === "AMOUNT") {
    bill_discount_amount = round2(Math.max(0, v));
  }

  if (bill_discount_amount > sub_total) bill_discount_amount = sub_total;

  const ship = round2(Math.max(0, num(shipping_charge)));
  const other = round2(Math.max(0, num(other_charge)));
  const ro = round2(num(round_off)); // can be negative/positive

  const grand_total = round2(sub_total - bill_discount_amount + ship + other + ro);
  return { sub_total, bill_discount_amount, grand_total };
}

/**
 * Pick only columns that exist in model
 */
function pickAttrs(model, payload) {
  const attrs = model?.rawAttributes || {};
  const out = {};
  for (const k of Object.keys(payload)) {
    if (attrs[k]) out[k] = payload[k];
  }
  return out;
}

/* ============================================================
 * Doc helpers (Challan/Invoice)
 * ============================================================ */

function normalizeDocType(v) {
  const s = String(v || "").trim().toUpperCase();
  return s === "INVOICE" ? "INVOICE" : "CHALLAN";
}

function docNarration(receipt) {
  const t = normalizeDocType(receipt.receive_doc_type);
  const no = safeText(receipt.doc_no || receipt.invoice_no || "");
  if (no) return `${t} ${no}`;
  return `Receipt ${safeText(receipt.receipt_no || receipt.id)}`;
}

/* ============================================================
 * ✅ School helpers (return school in API + print in PDF)
 * ============================================================ */

async function fetchSchoolForReceipt(receiptLike, opts = {}) {
  try {
    const schoolOrderId = num(receiptLike?.school_order_id);
    if (!schoolOrderId) return null;
    if (!SchoolOrder || !School) return null;

    const so = await SchoolOrder.findByPk(schoolOrderId, opts);
    if (!so) return null;

    const soJson = so.toJSON ? so.toJSON() : so;
    const schoolId = num(soJson.school_id ?? soJson.schoolId);
    if (!schoolId) return null;

    const school = await School.findByPk(schoolId, opts);
    if (!school) return null;

    return school.toJSON ? school.toJSON() : school;
  } catch {
    return null;
  }
}

async function attachSchoolToReceiptJson(receiptInstanceOrJson) {
  const r = receiptInstanceOrJson?.toJSON ? receiptInstanceOrJson.toJSON() : receiptInstanceOrJson;
  const school = await fetchSchoolForReceipt(r);
  return { ...(r || {}), school };
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

/* ============================================================
 * Order items received_qty helpers (optional)
 * ============================================================ */

async function bumpOrderReceivedQty({ school_order_id, lines, sign, t }) {
  if (!SchoolOrderItem) return;
  if (!school_order_id) return;

  for (const r of lines) {
    const book_id = num(r.book_id);
    const qty = Math.max(0, Math.floor(num(r.qty)));
    if (!book_id || qty <= 0) continue;

    const row = await SchoolOrderItem.findOne({
      where: { school_order_id: num(school_order_id), book_id },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!row) continue;

    const prev = num(row.received_qty);
    const next = prev + sign * qty;

    let finalVal = Math.max(0, next);
    if (row.total_order_qty != null || row.ordered_qty != null) {
      const ord = num(row.total_order_qty ?? row.ordered_qty);
      if (ord > 0) finalVal = Math.min(finalVal, ord);
    }

    row.received_qty = finalVal;
    await row.save({ transaction: t });
  }
}

/* ============================================================
 * Ledger Post (idempotent)
 * ============================================================ */

async function postPurchaseLedger({ receipt, t }) {
  if (!SupplierLedgerTxn) return;

  await SupplierLedgerTxn.destroy({
    where: {
      supplier_id: receipt.supplier_id,
      txn_type: "PURCHASE_RECEIVE",
      ref_table: "supplier_receipts",
      ref_id: receipt.id,
    },
    transaction: t,
  });

  await SupplierLedgerTxn.create(
    {
      supplier_id: receipt.supplier_id,
      txn_date: receipt.received_date || receipt.invoice_date || now(),
      txn_type: "PURCHASE_RECEIVE",
      ref_table: "supplier_receipts",
      ref_id: receipt.id,
      ref_no: receipt.receipt_no,
      debit: round2(receipt.grand_total),
      credit: 0,
      narration: docNarration(receipt),
    },
    { transaction: t }
  );
}

async function removePurchaseLedger({ receipt, t }) {
  if (!SupplierLedgerTxn) return;

  await SupplierLedgerTxn.destroy({
    where: {
      supplier_id: receipt.supplier_id,
      txn_type: "PURCHASE_RECEIVE",
      ref_table: "supplier_receipts",
      ref_id: receipt.id,
    },
    transaction: t,
  });
}

/* ============================================================
 * Inventory IN (idempotent via InventoryBatch ref)
 * ============================================================ */

async function ensureInventoryInForReceipt({ receipt, items, t }) {
  if (!InventoryBatch || !InventoryTxn) return;

  const existingCount = await InventoryBatch.count({
    where: pickAttrs(InventoryBatch, {
      ref_table: "supplier_receipts",
      ref_id: receipt.id,
    }),
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

  if (existingCount > 0) return;

  for (const r of items) {
    const batchPayload = pickAttrs(InventoryBatch, {
      book_id: r.book_id,
      supplier_id: receipt.supplier_id,

      source_type: "SUPPLIER_RECEIPT",
      ref_table: "supplier_receipts",
      ref_id: receipt.id,

      received_qty: r.qty,
      available_qty: r.qty,

      rate: r.rate,
      unit_cost: r.rate,
      cost_price: r.rate,
      purchase_price: r.rate,

      remarks: `${normalizeDocType(receipt.receive_doc_type)} ${safeText(receipt.doc_no || receipt.invoice_no || "")} • ${
        receipt.receipt_no
      }`,
    });

    const batch = await InventoryBatch.create(batchPayload, { transaction: t });

    const txnPayload = pickAttrs(InventoryTxn, {
      book_id: r.book_id,

      // supports either column in your model
      batch_id: batch.id,
      inventory_batch_id: batch.id,

      qty: r.qty,
      txn_type: "IN",
      type: "IN",

      ref_type: "SUPPLIER_RECEIPT",
      ref_table: "supplier_receipts",
      ref_id: receipt.id,
      ref_no: receipt.receipt_no,

      notes: `Receive via ${receipt.receipt_no}`,
    });

    await InventoryTxn.create(txnPayload, { transaction: t });
  }
}

/* ============================================================
 * Inventory Reverse (on cancel)
 * ============================================================ */

async function reverseInventoryForReceipt({ receipt, t }) {
  if (!InventoryBatch || !InventoryTxn) return;

  const batches = await InventoryBatch.findAll({
    where: pickAttrs(InventoryBatch, {
      ref_table: "supplier_receipts",
      ref_id: receipt.id,
    }),
    transaction: t,
    lock: t.LOCK.UPDATE,
    order: [["id", "ASC"]],
  });

  if (!batches.length) return;

  // strict safety
  for (const batch of batches) {
    const avail = num(batch.available_qty);
    const rec = num(batch.received_qty);
    const reverseQty = rec;
    if (reverseQty <= 0) continue;

    if (avail < reverseQty) {
      throw new Error(
        `Cannot cancel receipt: stock already used for book_id ${batch.book_id}. Available ${avail}, required ${reverseQty}.`
      );
    }
  }

  for (const batch of batches) {
    const reverseQty = num(batch.received_qty);
    if (reverseQty <= 0) continue;

    const txnPayload = pickAttrs(InventoryTxn, {
      book_id: batch.book_id,

      batch_id: batch.id,
      inventory_batch_id: batch.id,

      qty: reverseQty,
      txn_type: "OUT",
      type: "OUT",

      ref_type: "SUPPLIER_RECEIPT",
      ref_table: "supplier_receipts",
      ref_id: receipt.id,
      ref_no: receipt.receipt_no,

      notes: `Cancel receipt ${receipt.receipt_no}`,
    });

    await InventoryTxn.create(txnPayload, { transaction: t });

    batch.available_qty = num(batch.available_qty) - reverseQty;
    batch.received_qty = num(batch.received_qty) - reverseQty;
    await batch.save({ transaction: t });
  }
}

/* ============================================================
 * Posting Guard Helpers
 * ============================================================ */

function hasPostedFlag(modelInstance) {
  const attrs = SupplierReceipt?.rawAttributes || {};
  if (!attrs.posted_at) return false;
  return !!modelInstance.posted_at;
}

async function markPosted({ receipt, t }) {
  const attrs = SupplierReceipt?.rawAttributes || {};
  if (!attrs.posted_at) return;
  receipt.posted_at = now();
  await receipt.save({ transaction: t });
}

async function clearPosted({ receipt, t }) {
  const attrs = SupplierReceipt?.rawAttributes || {};
  if (!attrs.posted_at) return;
  receipt.posted_at = null;
  await receipt.save({ transaction: t });
}

async function postIfNotPosted({ receipt, lineItems, t }) {
  if (hasPostedFlag(receipt)) return;

  await ensureInventoryInForReceipt({ receipt, items: lineItems, t });
  await postPurchaseLedger({ receipt, t });
  await bumpOrderReceivedQty({
    school_order_id: receipt.school_order_id,
    lines: lineItems,
    sign: +1,
    t,
  });

  await markPosted({ receipt, t });
}

/* ============================================================
 * Validations for "received"
 * ============================================================ */

function validateReadyToReceive({ receipt, lineItems }) {
  const docType = normalizeDocType(receipt.receive_doc_type);
  const hasDocNo = safeText(receipt.doc_no || receipt.invoice_no || "").length > 0;

  if (docType === "INVOICE" && !hasDocNo) {
    return "Invoice No is required before marking received.";
  }

  const anyZeroRate = (lineItems || []).some((x) => num(x.rate) <= 0);
  if (anyZeroRate) {
    return "One or more items have missing/zero rate. Fill price before marking received.";
  }

  return null;
}

/* ============================================================
 * ✅ RECEIPT PDF builder -> Buffer
 * ✅ Updated:
 * - show School name
 * - show Academic session + Status
 * - currency formatting ₹
 * ============================================================ */

function buildSupplierReceiptPdfBuffer({
  receipt,
  supplier,
  school, // ✅ NEW
  companyProfile,
  items,
  pdfTitle = "SUPPLIER RECEIPT",
  showPrintDate = true,
}) {
  // ✅ NO ₹ SYMBOL: numbers only (2 decimals)
  const money = (v) => {
    const n = round2(v);
    return Number.isFinite(n) ? n.toFixed(2) : "0.00";
  };

  // ✅ Safe date formatting (en-IN)
  const formatDateIN = (d) => {
    if (!d) return "-";
    try {
      const dt = d instanceof Date ? d : new Date(d);
      if (Number.isNaN(dt.getTime())) return "-";
      return dt.toLocaleDateString("en-IN");
    } catch {
      return "-";
    }
  };

  return new Promise(async (resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];

    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageLeft = doc.page.margins.left;
    const pageRight = doc.page.width - doc.page.margins.right;
    const contentWidth = pageRight - pageLeft;

    const drawHR = () => {
      doc.save();
      doc.lineWidth(0.7);
      doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).stroke();
      doc.restore();
    };

    const ensureSpace = (neededHeight) => {
      const bottom = doc.page.height - doc.page.margins.bottom;
      if (doc.y + neededHeight > bottom) doc.addPage();
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
      if (companyProfile.name) lines.push({ text: companyProfile.name, font: "Helvetica-Bold", size: 16 });
      if (addrParts.length) lines.push({ text: addrParts.join(", "), font: "Helvetica", size: 9 });

      const contactParts = [];
      if (companyProfile.phone_primary) contactParts.push(`Phone: ${companyProfile.phone_primary}`);
      if (companyProfile.email) contactParts.push(`Email: ${companyProfile.email}`);
      if (contactParts.length) lines.push({ text: contactParts.join(" | "), font: "Helvetica", size: 9 });

      if (companyProfile.gstin) lines.push({ text: `GSTIN: ${companyProfile.gstin}`, font: "Helvetica", size: 9 });

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
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#000");
    const titleBoxW = Math.floor(contentWidth * 0.72);
    const titleX = pageLeft + Math.floor((contentWidth - titleBoxW) / 2);
    doc.text(safeText(pdfTitle), titleX, doc.y, { width: titleBoxW, align: "center" });
    doc.moveDown(0.5);

    /* ---------- TOP: Receipt No + School + Doc + Dates ---------- */
    const topY = doc.y;
    const leftTopW = Math.floor(contentWidth * 0.65);
    const rightTopX = pageLeft + Math.floor(contentWidth * 0.65);
    const rightTopW = pageRight - rightTopX;

    const receiptNo = safeText(receipt.receipt_no || receipt.id);

    const rType = normalizeDocType(receipt.receive_doc_type);
    const dNo = safeText(receipt.doc_no || receipt.invoice_no || "-");

    const dDate = formatDateIN(receipt.doc_date || receipt.invoice_date);
    const recvDate = formatDateIN(receipt.received_date);

    // ✅ School name (from school object)
    const schoolName = safeText(school?.name || school?.school_name || "");

    doc.font("Helvetica-Bold").fontSize(13).fillColor("#000");
    doc.text(`Receipt No: ${receiptNo}`, pageLeft, topY, { width: leftTopW, align: "left" });

    // ✅ School line (left)
    if (schoolName) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#000");
      doc.text(`School: ${schoolName}`, pageLeft, doc.y + 3, { width: leftTopW, align: "left" });
    }

    doc.font("Helvetica").fontSize(9).fillColor("#000");
    doc.text(`${rType === "INVOICE" ? "Invoice" : "Challan"} No: ${dNo}`, pageLeft, doc.y + 3, {
      width: leftTopW,
      align: "left",
    });

    doc.font("Helvetica").fontSize(9).fillColor("#000");
    doc.text(`${rType === "INVOICE" ? "Invoice" : "Challan"} Date: ${dDate}`, rightTopX, topY + 1, {
      width: rightTopW,
      align: "right",
    });
    doc.text(`Received Date: ${recvDate}`, rightTopX, doc.y + 2, { width: rightTopW, align: "right" });

    // ✅ Academic Session + Status
    const ac = safeText(receipt.academic_session || "");
    const st = safeText(receipt.status || "");
    if (ac) doc.text(`Academic Session: ${ac}`, rightTopX, doc.y + 2, { width: rightTopW, align: "right" });
    if (st) doc.text(`Status: ${st.toUpperCase()}`, rightTopX, doc.y + 2, { width: rightTopW, align: "right" });

    if (showPrintDate) {
      const pd = formatDateIN(new Date());
      doc.text(`Print Date: ${pd}`, rightTopX, doc.y + 2, { width: rightTopW, align: "right" });
    }

    doc.moveDown(0.6);
    drawHR();
    doc.moveDown(0.35);

    /* ---------- ✅ Highlighted Supplier Box ---------- */
    const supplierName = safeText(supplier?.name || "");
    if (supplierName) {
      const addr = safeText(supplier.address || supplier.address_line1 || supplier.full_address || "");
      const phone = safeText(supplier.phone || supplier.phone_primary || "");
      const email = safeText(supplier.email || "");
      const gstin = safeText(supplier.gstin || supplier.gst_no || supplier.gst || "");

      const boxX = pageLeft;
      const boxW = contentWidth;
      const startY2 = doc.y;

      const nameH = doc.heightOfString(supplierName, { width: boxW - 20 }) + 6;
      const lines = [
        addr ? addr : null,
        gstin ? `GSTIN: ${gstin}` : null,
        phone ? `Phone: ${phone}` : null,
        email ? `Email: ${email}` : null,
      ].filter(Boolean);

      doc.font("Helvetica").fontSize(10);
      const linesH = lines.reduce((sum, ln) => sum + doc.heightOfString(String(ln), { width: boxW - 20 }) + 2, 0);

      const boxH = Math.max(70, 18 + nameH + linesH + 14);

      ensureSpace(boxH + 8);

      doc.save();
      doc.rect(boxX, startY2, boxW, boxH).fill("#eef6ff");
      doc.rect(boxX, startY2, boxW, boxH).lineWidth(1).stroke("#1d4ed8");
      doc.restore();

      doc.font("Helvetica-Bold").fontSize(10).fillColor("#1e3a8a");
      doc.text("Supplier Details", boxX + 10, startY2 + 8);

      doc.font("Helvetica-Bold").fontSize(14).fillColor("#000");
      doc.text(supplierName, boxX + 10, startY2 + 24, { width: boxW - 20 });

      let yCursor = startY2 + 24 + nameH;
      doc.font("Helvetica").fontSize(10).fillColor("#000");

      for (const ln of lines) {
        doc.text(String(ln), boxX + 10, yCursor, { width: boxW - 20 });
        yCursor += doc.heightOfString(String(ln), { width: boxW - 20 }) + 2;
      }

      doc.y = startY2 + boxH + 10;
      drawHR();
      doc.moveDown(0.35);
    }

    /* ---------- Summary ---------- */
    const itemCount = (items || []).length;
    const subTotal = round2(receipt.sub_total);
    const billDisc = round2(receipt.bill_discount_amount);
    const grand = round2(receipt.grand_total);

    const boxY = doc.y;
    const boxH = 62;

    doc.save();
    doc.rect(pageLeft, boxY, contentWidth, boxH).fill("#f6f8fb");
    doc.restore();

    doc.font("Helvetica-Bold").fontSize(10).fillColor("#000");
    doc.text("Summary", pageLeft + 10, boxY + 8);

    doc.font("Helvetica").fontSize(9).fillColor("#000");
    doc.text(`Items: ${itemCount}`, pageLeft + 10, boxY + 26, { width: contentWidth / 2 - 10 });
    doc.text(`Sub Total: ${money(subTotal)}`, pageLeft + 10, boxY + 40, { width: contentWidth / 2 - 10 });

    doc.text(`Bill Discount: ${money(billDisc)}`, pageLeft + contentWidth / 2, boxY + 26, {
      width: contentWidth / 2 - 10,
      align: "right",
    });
    doc.text(`Grand Total: ${money(grand)}`, pageLeft + contentWidth / 2, boxY + 40, {
      width: contentWidth / 2 - 10,
      align: "right",
    });

    doc.y = boxY + boxH + 10;

    /* ---------- Table ---------- */
    const W = { sr: 24, title: 0, qty: 46, rate: 64, disc: 64, net: 72 };
    W.title = contentWidth - (W.sr + W.qty + W.rate + W.disc + W.net);
    const X = {
      sr: pageLeft,
      title: pageLeft + W.sr,
      qty: pageLeft + W.sr + W.title,
      rate: pageLeft + W.sr + W.title + W.qty,
      disc: pageLeft + W.sr + W.title + W.qty + W.rate,
      net: pageLeft + W.sr + W.title + W.qty + W.rate + W.disc,
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

      doc.text("Qty", X.qty, y, { width: W.qty, align: "center", lineBreak: false });
      doc.text("Rate", X.rate, y, { width: W.rate, align: "center", lineBreak: false });
      doc.text("Disc", X.disc, y, { width: W.disc, align: "center", lineBreak: false });
      doc.text("Net", X.net, y, { width: W.net, align: "center", lineBreak: false });

      doc.moveDown(1.1);
      drawHR2();
      doc.moveDown(0.25);
    };

    const rowHeight = (title, fontSize = 9) => {
      doc.font("Helvetica").fontSize(fontSize);
      const h = doc.heightOfString(title, { width: W.title });
      return Math.ceil(Math.max(h, fontSize + 2)) + 6;
    };

    printTableHeader();

    if (!items.length) {
      doc.font("Helvetica").fontSize(10).fillColor("#000");
      doc.text("No items found in this receipt.", { align: "left" });
    } else {
      let sr = 1;
      for (const it of items) {
        const title = safeText(it.book?.title || `Book #${it.book_id}`);
        const qty = num(it.qty);
        const rate = round2(it.rate);
        const disc = round2(it.discount_amount);
        const net = round2(it.net_amount);

        const rh = rowHeight(title, 9);
        ensureSpace(rh + 8);

        const y = doc.y;

        doc.font("Helvetica").fontSize(9).fillColor("#000");
        doc.text(String(sr), X.sr, y, { width: W.sr });
        doc.text(title, X.title, y, { width: W.title });

        doc.font("Helvetica-Bold").fontSize(10);
        doc.text(String(qty), X.qty, y - 1, { width: W.qty, align: "center" });
        doc.text(money(rate), X.rate, y - 1, { width: W.rate, align: "center" });
        doc.text(money(disc), X.disc, y - 1, { width: W.disc, align: "center" });
        doc.text(money(net), X.net, y - 1, { width: W.net, align: "center" });

        doc.y = y + rh - 3;
        sr++;
      }
    }

    /* ---------- Totals (bottom right) ---------- */
    const ship = round2(receipt.shipping_charge);
    const other = round2(receipt.other_charge);
    const ro = round2(receipt.round_off);

    ensureSpace(90);
    doc.moveDown(0.4);
    drawHR2();
    doc.moveDown(0.25);

    doc.font("Helvetica").fontSize(9).fillColor("#000");

    const rightColX = pageLeft + Math.floor(contentWidth * 0.55);
    const rightColW = pageRight - rightColX;

    const line = (label, value, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 10 : 9);
      doc.text(label, rightColX, doc.y, { width: rightColW * 0.6, align: "left" });
      doc.text(String(value), rightColX, doc.y - (bold ? 12 : 11), { width: rightColW, align: "right" });
      doc.moveDown(0.35);
    };

    line("Sub Total", money(subTotal));
    line("Bill Discount", money(billDisc));
    line("Shipping", money(ship));
    line("Other", money(other));
    line("Round Off", money(ro));
    line("Grand Total", money(grand), true);

    /* ---------- Remarks ---------- */
    const noteText = safeText(receipt.remarks || "");
    if (noteText) {
      const noteH = Math.max(38, doc.heightOfString(noteText, { width: contentWidth - 20 }) + 22);
      ensureSpace(noteH + 10);

      doc.moveDown(0.4);
      const y = doc.y;

      doc.save();
      doc.rect(pageLeft, y, contentWidth, noteH).fill("#fff3cd");
      doc.restore();

      doc.font("Helvetica-Bold").fontSize(10).fillColor("#000");
      doc.text("Remarks", pageLeft + 10, y + 8);

      doc.font("Helvetica").fontSize(9).fillColor("#000");
      doc.text(noteText, pageLeft + 10, y + 22, { width: contentWidth - 20 });

      doc.y = y + noteH + 2;
    }

    doc.end();
  });
}


/* ============================================================
 * Controller
 * ============================================================ */

/**
 * POST /api/supplier-receipts
 */
exports.create = async (request, reply) => {
  const body = request.body || {};

  const supplier_id = num(body.supplier_id);
  const school_order_id = body.school_order_id ? num(body.school_order_id) : null;

  const receive_doc_type = normalizeDocType(body.receive_doc_type);
  const doc_no = body.doc_no != null ? String(body.doc_no).trim() : null;
  const doc_date = body.doc_date ? new Date(body.doc_date) : null;

  const invoice_no = body.invoice_no ? String(body.invoice_no).trim() : null;
  const invoice_date = body.invoice_date ? new Date(body.invoice_date) : null;

  const academic_session = body.academic_session ? String(body.academic_session).trim() : null;
  const received_date = body.received_date ? new Date(body.received_date) : now();

  const remarks = body.remarks ? String(body.remarks) : null;

  const bill_discount_type = body.bill_discount_type || "NONE";
  const bill_discount_value = body.bill_discount_value ?? null;

  const shipping_charge = body.shipping_charge ?? 0;
  const other_charge = body.other_charge ?? 0;
  const round_off = body.round_off ?? 0;

  const requestedStatus = body.status ? String(body.status).toLowerCase() : "draft";

  const items = Array.isArray(body.items) ? body.items : [];

  if (!supplier_id) return reply.code(400).send({ error: "supplier_id is required" });
  if (!items.length) return reply.code(400).send({ error: "At least one item is required" });

  for (const [i, it] of items.entries()) {
    if (!it || !num(it.book_id)) {
      return reply.code(400).send({ error: `items[${i}].book_id is required` });
    }
    if (num(it.qty) <= 0) {
      return reply.code(400).send({ error: `items[${i}].qty must be > 0` });
    }
  }

  // INVOICE strict requirement
  if (receive_doc_type === "INVOICE") {
    const invNo = safeText(doc_no || invoice_no);
    if (!invNo) return reply.code(400).send({ error: "Invoice No is required." });

    for (const [i, it] of items.entries()) {
      if (num(it.rate) <= 0) {
        return reply.code(400).send({ error: `items[${i}].rate is required for invoice.` });
      }
    }
  }

  const anyMissingRate = items.some((it) => num(it.rate) <= 0);

  let finalStatus = requestedStatus;
  if (receive_doc_type === "INVOICE") finalStatus = "received";
  if (receive_doc_type === "CHALLAN" && anyMissingRate) finalStatus = "draft";
  if (!["draft", "received"].includes(finalStatus)) finalStatus = "draft";

  const t = await sequelize.transaction();
  try {
    const supplier = await Supplier.findByPk(supplier_id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!supplier) {
      await t.rollback();
      return reply.code(404).send({ error: "Supplier not found" });
    }

    const calcLines = items.map((it) => {
      const discType = it.item_discount_type || "NONE";
      const discVal = it.item_discount_value ?? null;

      const line = calcItemLine({
        qty: it.qty,
        rate: it.rate,
        discType,
        discVal,
      });

      return {
        book_id: num(it.book_id),
        qty: line.qty,
        rate: line.rate,
        item_discount_type: String(discType).toUpperCase(),
        item_discount_value: discVal === null || discVal === undefined ? null : round2(discVal),
        gross_amount: line.gross_amount,
        discount_amount: line.discount_amount,
        net_amount: line.net_amount,
      };
    });

    const itemsNetSum = calcLines.reduce((s, r) => s + num(r.net_amount), 0);

    const totals = calcHeaderTotals({
      itemsNetSum,
      billDiscountType: bill_discount_type,
      billDiscountValue: bill_discount_value,
      shipping_charge,
      other_charge,
      round_off,
    });

    if (totals.grand_total < 0) {
      await t.rollback();
      return reply.code(400).send({ error: "grand_total cannot be negative" });
    }

    const receipt_no = await makeReceiptNo(t);

    const final_doc_no = doc_no || invoice_no || null;
    const final_doc_date = doc_date || invoice_date || null;

    const receiptPayload = {
      supplier_id,
      school_order_id,
      receipt_no,

      receive_doc_type,
      doc_no: final_doc_no,
      doc_date: final_doc_date ? new Date(final_doc_date) : null,

      invoice_no: invoice_no || (receive_doc_type === "INVOICE" ? final_doc_no : null),
      invoice_date: invoice_date ? new Date(invoice_date) : null,

      academic_session,
      received_date,

      status: finalStatus,
      remarks,

      sub_total: totals.sub_total,

      bill_discount_type: String(bill_discount_type).toUpperCase(),
      bill_discount_value:
        bill_discount_value === null || bill_discount_value === undefined ? null : round2(bill_discount_value),
      bill_discount_amount: totals.bill_discount_amount,

      shipping_charge: round2(Math.max(0, num(shipping_charge))),
      other_charge: round2(Math.max(0, num(other_charge))),
      round_off: round2(num(round_off)),

      grand_total: totals.grand_total,
    };

    const receipt = await SupplierReceipt.create(receiptPayload, { transaction: t });

    await SupplierReceiptItem.bulkCreate(
      calcLines.map((r) => ({ ...r, supplier_receipt_id: receipt.id })),
      { transaction: t }
    );

    for (const r of calcLines) {
      if (num(r.rate) > 0) {
        await Book.update({ rate: round2(r.rate) }, { where: { id: r.book_id }, transaction: t });
      }
    }

    if (receipt.status === "received") {
      const lineItems = calcLines.map((x) => ({
        book_id: num(x.book_id),
        qty: Math.max(0, Math.floor(num(x.qty))),
        rate: round2(x.rate),
      }));

      const errMsg = validateReadyToReceive({ receipt, lineItems });
      if (errMsg) {
        await t.rollback();
        return reply.code(400).send({ error: errMsg });
      }

      await postIfNotPosted({ receipt, lineItems, t });
    }

    await t.commit();

    const full = await SupplierReceipt.findByPk(receipt.id, {
      include: [
        { model: Supplier, as: "supplier" },
        { model: SupplierReceiptItem, as: "items", include: [{ model: Book, as: "book" }] },
      ],
    });

    // ✅ attach school
    const fullWithSchool = await attachSchoolToReceiptJson(full);

    return reply.code(201).send({ receipt: fullWithSchool });
  } catch (err) {
    try {
      await t.rollback();
    } catch (_) {}
    request.log?.error?.(err);
    console.error("❌ createSupplierReceipt error:", err);
    return reply.code(500).send({
      error: "Failed to create supplier receipt",
      details: err?.message || String(err),
    });
  }
};

/**
 * ✅ PATCH /api/supplier-receipts/:id
 */
exports.update = async (request, reply) => {
  const id = num(request.params?.id);
  const body = request.body || {};

  const t = await sequelize.transaction();
  try {
    const receipt = await SupplierReceipt.findByPk(id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!receipt) {
      await t.rollback();
      return reply.code(404).send({ error: "Receipt not found" });
    }

    if (String(receipt.status).toLowerCase() === "cancelled") {
      await t.rollback();
      return reply.code(400).send({ error: "Cancelled receipt cannot be updated." });
    }

    const attrs = SupplierReceipt?.rawAttributes || {};
    const isPosted = hasPostedFlag(receipt);
    const statusLower = String(receipt.status || "").toLowerCase();

    // Always-allowed fields
    if (body.receive_doc_type != null && attrs.receive_doc_type) {
      receipt.receive_doc_type = normalizeDocType(body.receive_doc_type);
    }

    if (body.doc_no !== undefined && attrs.doc_no) {
      const v = String(body.doc_no || "").trim();
      receipt.doc_no = v ? v : null;
    }

    if (body.doc_date !== undefined && attrs.doc_date) {
      receipt.doc_date = body.doc_date ? new Date(body.doc_date) : null;
    }

    if (body.received_date !== undefined && attrs.received_date) {
      receipt.received_date = body.received_date ? new Date(body.received_date) : receipt.received_date;
    }

    if (body.academic_session !== undefined && attrs.academic_session) {
      const v = String(body.academic_session || "").trim();
      receipt.academic_session = v ? v : null;
    }

    if (body.remarks !== undefined && attrs.remarks) {
      const v = String(body.remarks || "").trim();
      receipt.remarks = v ? v : null;
    }

    // backward compat sync
    if (
      attrs.invoice_no &&
      (body.invoice_no !== undefined || body.doc_no !== undefined || body.receive_doc_type !== undefined)
    ) {
      const t2 = normalizeDocType(receipt.receive_doc_type);
      if (t2 === "INVOICE") {
        const inv = safeText(body.invoice_no ?? receipt.invoice_no ?? receipt.doc_no);
        receipt.invoice_no = inv ? inv : null;
      }
    }

    if (body.invoice_date !== undefined && attrs.invoice_date) {
      receipt.invoice_date = body.invoice_date ? new Date(body.invoice_date) : receipt.invoice_date;
    }

    const wantsItemsEdit = Array.isArray(body.items);
    const wantsHeaderMoneyEdit =
      body.bill_discount_type !== undefined ||
      body.bill_discount_value !== undefined ||
      body.shipping_charge !== undefined ||
      body.other_charge !== undefined ||
      body.round_off !== undefined;

    if (isPosted) {
      if (wantsItemsEdit || wantsHeaderMoneyEdit) {
        await t.rollback();
        return reply.code(400).send({
          error: "Receipt already posted. You can edit only Doc fields (Challan/Invoice No/Date, GRN, Remarks).",
        });
      }
    } else {
      if (statusLower !== "draft") {
        if (wantsItemsEdit || wantsHeaderMoneyEdit) {
          await t.rollback();
          return reply.code(400).send({ error: "Only DRAFT receipt can be edited for qty/price/discount/charges." });
        }
      } else {
        if (body.bill_discount_type !== undefined && attrs.bill_discount_type) {
          receipt.bill_discount_type = String(body.bill_discount_type || "NONE").toUpperCase();
        }
        if (body.bill_discount_value !== undefined && attrs.bill_discount_value) {
          const v = body.bill_discount_value;
          receipt.bill_discount_value = v === null || v === undefined || v === "" ? null : round2(v);
        }
        if (body.shipping_charge !== undefined && attrs.shipping_charge) {
          receipt.shipping_charge = round2(Math.max(0, num(body.shipping_charge)));
        }
        if (body.other_charge !== undefined && attrs.other_charge) {
          receipt.other_charge = round2(Math.max(0, num(body.other_charge)));
        }
        if (body.round_off !== undefined && attrs.round_off) {
          receipt.round_off = round2(num(body.round_off));
        }

        let calcLines = null;

        if (wantsItemsEdit) {
          const items = body.items || [];
          if (!items.length) {
            await t.rollback();
            return reply.code(400).send({ error: "At least one item is required." });
          }

          for (const [i, it] of items.entries()) {
            if (!it || !num(it.book_id)) return reply.code(400).send({ error: `items[${i}].book_id is required` });
            if (num(it.qty) <= 0) return reply.code(400).send({ error: `items[${i}].qty must be > 0` });
          }

          const docType = normalizeDocType(receipt.receive_doc_type);
          if (docType === "INVOICE") {
            const invNo = safeText(receipt.doc_no || receipt.invoice_no);
            if (!invNo) {
              await t.rollback();
              return reply.code(400).send({ error: "Invoice No is required for INVOICE type." });
            }
            for (const [i, it] of items.entries()) {
              if (num(it.rate) <= 0) {
                await t.rollback();
                return reply.code(400).send({ error: `items[${i}].rate is required for invoice.` });
              }
            }
          }

          calcLines = items.map((it) => {
            const discType = it.item_discount_type || "NONE";
            const discVal = it.item_discount_value ?? null;

            const line = calcItemLine({
              qty: it.qty,
              rate: it.rate,
              discType,
              discVal,
            });

            return {
              book_id: num(it.book_id),
              qty: line.qty,
              rate: line.rate,
              item_discount_type: String(discType).toUpperCase(),
              item_discount_value: discVal === null || discVal === undefined ? null : round2(discVal),
              gross_amount: line.gross_amount,
              discount_amount: line.discount_amount,
              net_amount: line.net_amount,
            };
          });

          await SupplierReceiptItem.destroy({ where: { supplier_receipt_id: receipt.id }, transaction: t });
          await SupplierReceiptItem.bulkCreate(
            calcLines.map((r) => ({ ...r, supplier_receipt_id: receipt.id })),
            { transaction: t }
          );

          for (const r of calcLines) {
            if (num(r.rate) > 0) {
              await Book.update({ rate: round2(r.rate) }, { where: { id: r.book_id }, transaction: t });
            }
          }
        }

        if (wantsItemsEdit || wantsHeaderMoneyEdit) {
          const itemsForTotals =
            calcLines ||
            (await SupplierReceiptItem.findAll({
              where: { supplier_receipt_id: receipt.id },
              transaction: t,
              lock: t.LOCK.UPDATE,
            })).map((x) => x.toJSON());

          const itemsNetSum = (itemsForTotals || []).reduce((s, r) => s + num(r.net_amount), 0);

          const totals = calcHeaderTotals({
            itemsNetSum,
            billDiscountType: receipt.bill_discount_type,
            billDiscountValue: receipt.bill_discount_value,
            shipping_charge: receipt.shipping_charge,
            other_charge: receipt.other_charge,
            round_off: receipt.round_off,
          });

          if (totals.grand_total < 0) {
            await t.rollback();
            return reply.code(400).send({ error: "grand_total cannot be negative" });
          }

          receipt.sub_total = totals.sub_total;
          receipt.bill_discount_amount = totals.bill_discount_amount;
          receipt.grand_total = totals.grand_total;
        }
      }
    }

    await receipt.save({ transaction: t });
    await t.commit();

    const full = await SupplierReceipt.findByPk(receipt.id, {
      include: [
        { model: Supplier, as: "supplier" },
        { model: SupplierReceiptItem, as: "items", include: [{ model: Book, as: "book" }] },
      ],
    });

    // ✅ attach school
    const fullWithSchool = await attachSchoolToReceiptJson(full);

    return reply.send({ receipt: fullWithSchool });
  } catch (err) {
    try {
      await t.rollback();
    } catch (_) {}
    request.log?.error?.(err);
    console.error("❌ updateSupplierReceipt error:", err);
    return reply.code(500).send({
      error: "Failed to update receipt",
      details: err?.message || String(err),
    });
  }
};

/**
 * GET /api/supplier-receipts
 * ✅ includes supplier + (school if available)
 */
exports.list = async (request, reply) => {
  try {
    const { supplier_id, status, from, to, q, receive_doc_type, doc_no } = request.query || {};

    const where = {};
    if (supplier_id) where.supplier_id = num(supplier_id);
    if (status) where.status = String(status);

    if (receive_doc_type) where.receive_doc_type = normalizeDocType(receive_doc_type);
    if (doc_no && String(doc_no).trim()) where.doc_no = { [Op.like]: `%${String(doc_no).trim()}%` };

    if (from || to) {
      where.received_date = {};
      if (from) where.received_date[Op.gte] = String(from);
      if (to) where.received_date[Op.lte] = String(to);
    }

    if (q && String(q).trim()) {
      const s = `%${String(q).trim()}%`;
      where[Op.or] = [
        { receipt_no: { [Op.like]: s } },
        { doc_no: { [Op.like]: s } },
        { invoice_no: { [Op.like]: s } },
      ];
    }

    const rows = await SupplierReceipt.findAll({
      where,
      order: [["id", "DESC"]],
      include: [{ model: Supplier, as: "supplier" }],
      limit: 200,
    });

    // ✅ attach school for each row (best-effort)
    const receipts = [];
    for (const r of rows) {
      receipts.push(await attachSchoolToReceiptJson(r));
    }

    return reply.send({ receipts });
  } catch (err) {
    request.log?.error?.(err);
    console.error("❌ listSupplierReceipts error:", err);
    return reply.code(500).send({ error: "Failed to list receipts" });
  }
};

/**
 * GET /api/supplier-receipts/:id
 * ✅ includes supplier + items + (school if available)
 */
exports.getById = async (request, reply) => {
  try {
    const id = num(request.params?.id);

    const row = await SupplierReceipt.findByPk(id, {
      include: [
        { model: Supplier, as: "supplier" },
        { model: SupplierReceiptItem, as: "items", include: [{ model: Book, as: "book" }] },
      ],
    });

    if (!row) return reply.code(404).send({ error: "Receipt not found" });

    const receipt = await attachSchoolToReceiptJson(row);
    return reply.send({ receipt });
  } catch (err) {
    request.log?.error?.(err);
    console.error("❌ getSupplierReceiptById error:", err);
    return reply.code(500).send({ error: "Failed to fetch receipt" });
  }
};

/**
 * ✅ GET /api/supplier-receipts/:id/pdf
 * ✅ Title & filename auto by doc type
 * ✅ Adds school name
 */
exports.printReceiptPdf = async (request, reply) => {
  const id = num(request.params?.id);

  try {
    const receipt = await SupplierReceipt.findByPk(id, {
      include: [
        { model: Supplier, as: "supplier" },
        { model: SupplierReceiptItem, as: "items", include: [{ model: Book, as: "book" }] },
      ],
      order: [[{ model: SupplierReceiptItem, as: "items" }, "id", "ASC"]],
    });

    if (!receipt) {
      return reply.code(404).send({ error: "NotFound", message: "Supplier receipt not found" });
    }

    const companyProfile = await CompanyProfile.findOne({
      where: { is_active: true },
      order: [
        ["is_default", "DESC"],
        ["id", "ASC"],
      ],
    });

    const r = receipt.toJSON();
    const supplier = r.supplier || null;
    const items = r.items || [];

    // ✅ fetch school (best-effort)
    const school = await fetchSchoolForReceipt(r);

    const docType = normalizeDocType(r.receive_doc_type);
    const docLabel = docType === "INVOICE" ? "INVOICE" : "CHALLAN";

    const safeNo = String(r.receipt_no || `receipt-${r.id}`).replace(/[^\w\-]+/g, "_");
    const fileName = `supplier-${docLabel.toLowerCase()}-${safeNo}.pdf`;

    const pdfBuffer = await buildSupplierReceiptPdfBuffer({
      receipt: r,
      supplier,
      school,
      companyProfile,
      items,
      pdfTitle: `SUPPLIER ${docLabel}`,
      showPrintDate: true,
    });

    reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `inline; filename="${fileName}"`)
      .send(pdfBuffer);

    return reply;
  } catch (err) {
    request.log?.error?.(err);
    console.error("❌ printReceiptPdf error:", err);
    if (!reply.sent) {
      return reply.code(500).send({
        error: "InternalServerError",
        message: err?.message || "Failed to generate supplier receipt PDF",
      });
    }
  }
};

/**
 * PATCH /api/supplier-receipts/:id/status
 */
exports.updateStatus = async (request, reply) => {
  const id = num(request.params?.id);
  const nextStatus = String(request.body?.status || "").toLowerCase();

  if (!["draft", "received", "cancelled"].includes(nextStatus)) {
    return reply.code(400).send({ error: "Invalid status" });
  }

  const t = await sequelize.transaction();
  try {
    const receipt = await SupplierReceipt.findByPk(id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!receipt) {
      await t.rollback();
      return reply.code(404).send({ error: "Receipt not found" });
    }

    const prevStatus = String(receipt.status || "draft").toLowerCase();

    if (prevStatus === "cancelled") {
      await t.rollback();
      return reply.code(400).send({ error: "Cancelled receipt cannot be changed." });
    }

    const needItems =
      nextStatus === "received" ||
      (prevStatus === "received" && (nextStatus === "draft" || nextStatus === "cancelled"));

    const items = needItems
      ? await SupplierReceiptItem.findAll({
          where: { supplier_receipt_id: receipt.id },
          transaction: t,
          lock: t.LOCK.UPDATE,
        })
      : [];

    const lineItems = (items || []).map((x) => ({
      book_id: num(x.book_id),
      qty: Math.max(0, Math.floor(num(x.qty))),
      rate: round2(x.rate),
    }));

    if (prevStatus !== "received" && nextStatus === "received") {
      const errMsg = validateReadyToReceive({ receipt, lineItems });
      if (errMsg) {
        await t.rollback();
        return reply.code(400).send({ error: errMsg });
      }
    }

    receipt.status = nextStatus;
    await receipt.save({ transaction: t });

    if (prevStatus !== "received" && nextStatus === "received") {
      await postIfNotPosted({ receipt, lineItems, t });
    }

    if (prevStatus === "received" && nextStatus === "cancelled") {
      if (hasPostedFlag(receipt)) {
        await removePurchaseLedger({ receipt, t });
        await reverseInventoryForReceipt({ receipt, t });

        await bumpOrderReceivedQty({
          school_order_id: receipt.school_order_id,
          lines: lineItems,
          sign: -1,
          t,
        });

        await clearPosted({ receipt, t });
      } else {
        await removePurchaseLedger({ receipt, t });
      }
    }

    if (prevStatus === "draft" && nextStatus === "cancelled") {
      await removePurchaseLedger({ receipt, t });
      await clearPosted({ receipt, t });
    }

    await t.commit();
    return reply.send({ ok: true, id: receipt.id, status: receipt.status });
  } catch (err) {
    try {
      await t.rollback();
    } catch (_) {}
    request.log?.error?.(err);
    console.error("❌ updateSupplierReceiptStatus error:", err);
    return reply.code(500).send({
      error: "Failed to update status",
      details: err?.message || String(err),
    });
  }
};
