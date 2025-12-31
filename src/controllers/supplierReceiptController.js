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

  // Optional (if exists in your models/index.js)
  SchoolOrderItem,
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

/**
 * Generate receipt number like: SR-2025-12-000001
 */
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
    // NOTE: AMOUNT here means "line discount amount" as per current legacy logic
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

function docLabel(receive_doc_type) {
  return normalizeDocType(receive_doc_type) === "INVOICE" ? "Invoice No" : "Challan No";
}

function docNarration(receipt) {
  const t = normalizeDocType(receipt.receive_doc_type);
  const no = safeText(receipt.doc_no || receipt.invoice_no || "");
  if (no) return `${t} ${no}`;
  return `Receipt ${safeText(receipt.receipt_no || receipt.id)}`;
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
  if (!SchoolOrderItem) return; // optional
  if (!school_order_id) return;

  // sign: +1 for receive, -1 for cancel/reverse
  for (const r of lines) {
    const book_id = num(r.book_id);
    const qty = Math.max(0, Math.floor(num(r.qty)));
    if (!book_id || qty <= 0) continue;

    // lock row if exists
    const row = await SchoolOrderItem.findOne({
      where: { school_order_id: num(school_order_id), book_id },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    // if no row found, skip silently (some setups don't store order-item per book)
    if (!row) continue;

    const prev = num(row.received_qty);
    const next = prev + sign * qty;

    // clamp to [0, ordered_qty if exists]
    let finalVal = Math.max(0, next);
    if (row.total_order_qty != null || row.ordered_qty != null) {
      const ord = num(row.total_order_qty ?? row.ordered_qty);
      if (ord > 0) finalVal = Math.min(finalVal, ord);
    }

    row.received_qty = finalVal;
    await row.save({ transaction: t });
  }
}

/**
 * Ledger Post (idempotent)
 */
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

/**
 * Ledger Remove (idempotent)
 */
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

/**
 * Inventory IN for receipt (idempotent by checking existing batches for this receipt)
 */
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

  // if already created earlier, skip to avoid duplicates
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

      remarks: `${normalizeDocType(receipt.receive_doc_type)} ${safeText(receipt.doc_no || receipt.invoice_no || "")} • ${receipt.receipt_no}`,
    });

    const batch = await InventoryBatch.create(batchPayload, { transaction: t });

    const txnPayload = pickAttrs(InventoryTxn, {
      book_id: r.book_id,
      batch_id: batch.id,
      qty: r.qty,
      txn_type: "IN",
      type: "IN",
      ref_table: "supplier_receipts",
      ref_id: receipt.id,
      notes: `Receive via ${receipt.receipt_no}`,
    });

    await InventoryTxn.create(txnPayload, { transaction: t });
  }
}

/**
 * Inventory reverse on cancel:
 * - only allowed if all batches created by this receipt still have enough available_qty to reverse
 */
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

  if (!batches.length) return; // nothing to reverse

  for (const b of batches) {
    const avail = num(b.available_qty);
    const rec = num(b.received_qty);
    const reverseQty = rec;
    if (reverseQty <= 0) continue;

    if (avail < reverseQty) {
      throw new Error(
        `Cannot cancel receipt: stock already used for book_id ${b.book_id}. Available ${avail}, required ${reverseQty}.`
      );
    }
  }

  for (const b of batches) {
    const reverseQty = num(b.received_qty);
    if (reverseQty <= 0) continue;

    const txnPayload = pickAttrs(InventoryTxn, {
      book_id: b.book_id,
      batch_id: b.id,
      qty: reverseQty,
      txn_type: "OUT",
      type: "OUT",
      ref_table: "supplier_receipts",
      ref_id: receipt.id,
      notes: `Cancel receipt ${receipt.receipt_no}`,
    });
    await InventoryTxn.create(txnPayload, { transaction: t });

    b.available_qty = num(b.available_qty) - reverseQty;
    b.received_qty = num(b.received_qty) - reverseQty;

    await b.save({ transaction: t });
  }
}

/* ============================================================
 * ✅ RECEIPT PDF builder -> Buffer
 * ============================================================ */
function buildSupplierReceiptPdfBuffer({
  receipt,
  supplier,
  companyProfile,
  items,
  pdfTitle = "SUPPLIER RECEIPT",
  showPrintDate = true,
}) {
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
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#000");
    const titleBoxW = Math.floor(contentWidth * 0.72);
    const titleX = pageLeft + Math.floor((contentWidth - titleBoxW) / 2);
    doc.text(safeText(pdfTitle), titleX, doc.y, { width: titleBoxW, align: "center" });
    doc.moveDown(0.5);

    /* ---------- TOP: Receipt No + Doc + Dates ---------- */
    const topY = doc.y;
    const leftTopW = Math.floor(contentWidth * 0.65);
    const rightTopX = pageLeft + Math.floor(contentWidth * 0.65);
    const rightTopW = pageRight - rightTopX;

    const receiptNo = safeText(receipt.receipt_no || receipt.id);

    const rType = normalizeDocType(receipt.receive_doc_type);
    const dNo = safeText(receipt.doc_no || receipt.invoice_no || "-");
    const dDate = receipt.doc_date
      ? new Date(receipt.doc_date).toLocaleDateString("en-IN")
      : receipt.invoice_date
      ? new Date(receipt.invoice_date).toLocaleDateString("en-IN")
      : "-";

    const recvDate = receipt.received_date ? new Date(receipt.received_date).toLocaleDateString("en-IN") : "-";

    doc.font("Helvetica-Bold").fontSize(13).fillColor("#000");
    doc.text(`Receipt No: ${receiptNo}`, pageLeft, topY, { width: leftTopW, align: "left" });

    doc.font("Helvetica").fontSize(9).fillColor("#000");
    doc.text(`${rType === "INVOICE" ? "Invoice" : "Challan"} No: ${dNo}`, pageLeft, doc.y + 2, {
      width: leftTopW,
      align: "left",
    });

    doc.font("Helvetica").fontSize(9).fillColor("#000");
    doc.text(`${rType === "INVOICE" ? "Invoice" : "Challan"} Date: ${dDate}`, rightTopX, topY + 1, {
      width: rightTopW,
      align: "right",
    });
    doc.text(`Received Date: ${recvDate}`, rightTopX, doc.y + 2, { width: rightTopW, align: "right" });

    if (showPrintDate) {
      const pd = new Date().toLocaleDateString("en-IN");
      doc.text(`Print Date: ${pd}`, rightTopX, doc.y + 2, { width: rightTopW, align: "right" });
    }

    doc.moveDown(0.6);
    drawHR();
    doc.moveDown(0.35);

    /* ---------- From Supplier ---------- */
    if (supplier && supplier.name) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#000");
      doc.text("From Supplier:", pageLeft, doc.y);

      doc.font("Helvetica").fontSize(10).fillColor("#000");
      doc.text(safeText(supplier.name), pageLeft, doc.y);

      const subLines = [];
      const addr = supplier.address || supplier.address_line1 || supplier.full_address || "";
      const phone = supplier.phone || supplier.phone_primary || "";
      const email = supplier.email || "";

      if (addr) subLines.push(safeText(addr));
      if (phone) subLines.push(`Phone: ${safeText(phone)}`);
      if (email) subLines.push(`Email: ${safeText(email)}`);

      doc.font("Helvetica").fontSize(9).fillColor("#000");
      for (const ln of subLines) doc.text(ln, pageLeft, doc.y, { width: Math.floor(contentWidth * 0.72) });
    }

    doc.moveDown(0.25);
    drawHR();
    doc.moveDown(0.4);

    /* ---------- Summary ---------- */
    const itemCount = (items || []).length;
    const subTotal = round2(receipt.sub_total);
    const billDisc = round2(receipt.bill_discount_amount);
    const ship = round2(receipt.shipping_charge);
    const other = round2(receipt.other_charge);
    const ro = round2(receipt.round_off);
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
    doc.text(`Sub Total: ${subTotal}`, pageLeft + 10, boxY + 40, { width: contentWidth / 2 - 10 });

    doc.text(`Bill Discount: ${billDisc}`, pageLeft + contentWidth / 2, boxY + 26, {
      width: contentWidth / 2 - 10,
      align: "right",
    });
    doc.text(`Grand Total: ${grand}`, pageLeft + contentWidth / 2, boxY + 40, {
      width: contentWidth / 2 - 10,
      align: "right",
    });

    doc.y = boxY + boxH + 10;

    /* ---------- Table ---------- */
    const W = { sr: 24, title: 0, qty: 46, rate: 56, disc: 60, net: 66 };
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
        doc.text(String(rate), X.rate, y - 1, { width: W.rate, align: "center" });
        doc.text(String(disc), X.disc, y - 1, { width: W.disc, align: "center" });
        doc.text(String(net), X.net, y - 1, { width: W.net, align: "center" });

        doc.y = y + rh - 3;
        sr++;
      }
    }

    /* ---------- Totals (bottom right) ---------- */
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

    line("Sub Total", subTotal);
    line("Bill Discount", billDisc);
    line("Shipping", ship);
    line("Other", other);
    line("Round Off", ro);
    line("Grand Total", grand, true);

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

  // ✅ NEW: Challan/Invoice support
  const receive_doc_type = normalizeDocType(body.receive_doc_type);
  const doc_no = body.doc_no != null ? String(body.doc_no).trim() : null;
  const doc_date = body.doc_date ? new Date(body.doc_date) : null;

  // Backward compatibility
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

  const status = body.status ? String(body.status).toLowerCase() : "received";
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

    // Choose doc fields:
    // - prefer new doc_no/doc_date
    // - fallback to invoice_no/invoice_date
    const final_doc_no = doc_no || invoice_no || null;
    const final_doc_date = doc_date || invoice_date || null;

    const receipt = await SupplierReceipt.create(
      {
        supplier_id,
        school_order_id,
        receipt_no,

        receive_doc_type,
        doc_no: final_doc_no,
        doc_date: final_doc_date ? new Date(final_doc_date) : null,

        // backward compat store (optional)
        invoice_no: invoice_no || null,
        invoice_date: invoice_date ? new Date(invoice_date) : null,

        academic_session,
        received_date,

        status: status === "draft" ? "draft" : "received",
        remarks,

        sub_total: totals.sub_total,

        bill_discount_type: String(bill_discount_type).toUpperCase(),
        bill_discount_value:
          bill_discount_value === null || bill_discount_value === undefined
            ? null
            : round2(bill_discount_value),
        bill_discount_amount: totals.bill_discount_amount,

        shipping_charge: round2(Math.max(0, num(shipping_charge))),
        other_charge: round2(Math.max(0, num(other_charge))),
        round_off: round2(num(round_off)),

        grand_total: totals.grand_total,
      },
      { transaction: t }
    );

    await SupplierReceiptItem.bulkCreate(
      calcLines.map((r) => ({ ...r, supplier_receipt_id: receipt.id })),
      { transaction: t }
    );

    // optional: update last purchase rate on book
    for (const r of calcLines) {
      const updatePayload = { rate: round2(r.rate) };
      await Book.update(updatePayload, { where: { id: r.book_id }, transaction: t });
    }

    if (receipt.status === "received") {
      await ensureInventoryInForReceipt({ receipt, items: calcLines, t });
      await postPurchaseLedger({ receipt, t });

      // ✅ critical for partial receiving pending calc (if SchoolOrderItem exists)
      await bumpOrderReceivedQty({ school_order_id, lines: calcLines, sign: +1, t });
    }

    await t.commit();

    const full = await SupplierReceipt.findByPk(receipt.id, {
      include: [
        { model: Supplier, as: "supplier" },
        { model: SupplierReceiptItem, as: "items", include: [{ model: Book, as: "book" }] },
      ],
    });

    return reply.code(201).send({ receipt: full });
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
 * GET /api/supplier-receipts
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
      // filter on received_date (GRN date) is generally more accurate for receiving reports
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

    return reply.send({ receipts: rows });
  } catch (err) {
    request.log?.error?.(err);
    console.error("❌ listSupplierReceipts error:", err);
    return reply.code(500).send({ error: "Failed to list receipts" });
  }
};

/**
 * GET /api/supplier-receipts/:id
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
    return reply.send({ receipt: row });
  } catch (err) {
    request.log?.error?.(err);
    console.error("❌ getSupplierReceiptById error:", err);
    return reply.code(500).send({ error: "Failed to fetch receipt" });
  }
};

/**
 * ✅ GET /api/supplier-receipts/:id/pdf
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

    const safeNo = String(r.receipt_no || `receipt-${r.id}`).replace(/[^\w\-]+/g, "_");

    const pdfBuffer = await buildSupplierReceiptPdfBuffer({
      receipt: r,
      supplier,
      companyProfile,
      items,
      pdfTitle: "SUPPLIER RECEIPT",
      showPrintDate: true,
    });

    reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `inline; filename="supplier-receipt-${safeNo}.pdf"`)
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

    const items =
      nextStatus === "received" || (prevStatus === "received" && nextStatus === "cancelled")
        ? await SupplierReceiptItem.findAll({
            where: { supplier_receipt_id: receipt.id },
            transaction: t,
            lock: t.LOCK.UPDATE,
          })
        : [];

    if (prevStatus === "cancelled") {
      await t.rollback();
      return reply.code(400).send({ error: "Cancelled receipt cannot be changed." });
    }

    receipt.status = nextStatus;
    await receipt.save({ transaction: t });

    if (prevStatus !== "received" && nextStatus === "received") {
      const lineItems = (items || []).map((x) => ({
        book_id: num(x.book_id),
        qty: Math.max(0, Math.floor(num(x.qty))),
        rate: round2(x.rate),
      }));

      await ensureInventoryInForReceipt({ receipt, items: lineItems, t });
      await postPurchaseLedger({ receipt, t });

      // ✅ apply order received qty
      await bumpOrderReceivedQty({
        school_order_id: receipt.school_order_id,
        lines: lineItems,
        sign: +1,
        t,
      });
    }

    if (prevStatus === "received" && nextStatus === "cancelled") {
      await removePurchaseLedger({ receipt, t });
      await reverseInventoryForReceipt({ receipt, t });

      // ✅ reverse order received qty
      const lineItems = (items || []).map((x) => ({
        book_id: num(x.book_id),
        qty: Math.max(0, Math.floor(num(x.qty))),
        rate: round2(x.rate),
      }));

      await bumpOrderReceivedQty({
        school_order_id: receipt.school_order_id,
        lines: lineItems,
        sign: -1,
        t,
      });
    }

    if (prevStatus === "draft" && nextStatus === "cancelled") {
      await removePurchaseLedger({ receipt, t });
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
