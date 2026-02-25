// controllers/schoolSalesController.js
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const PDFDocument = require("pdfkit");
const { Op } = require("sequelize");

const {
  sequelize,

  // master
  School,
  Book,
  Publisher, // ✅ IMPORTANT (Book.publisher_id -> Publisher)
  Product,
  User,

  // inventory
  InventoryBatch,
  InventoryTxn,

  // requirements
  SchoolBookRequirement,

  // sales
  SchoolSale,
  SchoolSaleItem,

  // company profile
  CompanyProfile,
} = require("../models");

const { sendMail } = require("../config/email");

/* =========================
   Helpers
   ========================= */

const TXN_TYPE = { IN: "IN", OUT: "OUT" };

const ADMINISH_ROLES = ["ADMIN", "SUPERADMIN", "OWNER", "STAFF", "ACCOUNTANT"];
const SELLER_ROLES = ["DISTRIBUTOR", ...ADMINISH_ROLES];

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

function nowISODate() {
  return new Date().toISOString().slice(0, 10);
}

function makeSaleNo() {
  return (
    "SS" +
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

function enforceSalesAuthorization(user) {
  if (!user) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
  if (!hasAnyRole(user, SELLER_ROLES)) {
    const err = new Error("Not allowed");
    err.statusCode = 403;
    throw err;
  }
}

function enforceSaleOwnershipOrAdmin(user, saleRow) {
  if (!saleRow) return;
  if (isAdminish(user)) return;

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

/** generate unique sale_no inside txn */
async function generateUniqueSaleNo(t) {
  let sale_no = makeSaleNo();
  for (let i = 0; i < 10; i++) {
    const exists = await SchoolSale.findOne({ where: { sale_no }, transaction: t });
    if (!exists) return sale_no;
    sale_no = makeSaleNo();
  }
  return sale_no;
}

/** safely update optional columns without crashing */
async function safeSaleUpdate(sale, data, t) {
  const obj = {};
  for (const k of Object.keys(data)) {
    if (k in sale) obj[k] = data[k];
  }
  return sale.update(obj, { transaction: t || undefined });
}

/* =========================
   Email helpers
   ========================= */

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

// model name: sequelize.models.SaleInvoiceEmailLog (optional)
const getSaleEmailLogModel = () => sequelize?.models?.SaleInvoiceEmailLog || null;

/* =========================
   Pricing helpers
   ========================= */

function pickDefaultUnitPrice({ book, product }) {
  return round2(
    num(book?.rate) ||
      num(book?.selling_price) ||
      num(book?.mrp) ||
      num(product?.selling_price) ||
      num(product?.mrp) ||
      0
  );
}

function resolveUnitPrice({ reqRow, book_id, book, product, body }) {
  const overrides = body?.price_overrides || {};
  const overrideReq = overrides?.[`req_${reqRow?.id}`];
  const overrideBook = overrides?.[`book_${book_id}`];

  const defaultUnit = pickDefaultUnitPrice({ book, product });

  const unit = round2(
    num(overrideReq) || num(overrideBook) || num(body?.default_unit_price) || defaultUnit
  );

  return {
    unit,
    defaultUnit,
    isOverridden:
      num(overrideReq) > 0 || num(overrideBook) > 0 || num(body?.default_unit_price) > 0,
  };
}

/* =========================
   LOGO helpers (URL / local path / base64 data-url)
   ========================= */

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

  // pdfkit doesn't support svg/webp directly reliably
  if (/\.(svg|webp)(\?.*)?$/i.test(s)) return null;

  if (s.startsWith("data:image/")) {
    try {
      const base64 = s.split(",")[1];
      if (!base64) return null;
      return Buffer.from(base64, "base64");
    } catch {
      return null;
    }
  }

  if (s.startsWith("http://") || s.startsWith("https://")) {
    try {
      return await fetchUrlBuffer(s);
    } catch {
      return null;
    }
  }

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

/* =========================
   Publisher resolver helpers (✅ aligns with your Book model)
   ========================= */

function publisherNameFromBook(bookOrJson) {
  const b = bookOrJson || null;
  if (!b) return "";
  // prefer association
  const assoc = b.publisher || b.Publisher || null;
  const assocName = safeText(assoc?.name || "");
  if (assocName) return assocName;

  // fallbacks (if you have legacy columns anywhere)
  const legacy = safeText(b.publisher_name || b.publisher || "");
  return legacy;
}

/* =========================
   ✅ Enrich helpers (FIX publisher not coming)
   - attaches `book` (with publisher) to each item
   - fills snapshots if missing (publisher_snapshot etc.)
   ========================= */

async function enrichSaleItems(items) {
  const arr = Array.isArray(items) ? items : [];
  const jsonItems = arr.map((x) => x?.toJSON?.() || x);

  const bookIds = jsonItems.map((x) => num(x.book_id)).filter(Boolean);
  if (!bookIds.length) return jsonItems;

  const books = await Book.findAll({
    where: { id: bookIds },
    // include publisher association (Book.belongsTo(Publisher, as:"publisher"))
    include: Publisher
      ? [
          {
            model: Publisher,
            as: "publisher",
            required: false,
            attributes: ["id", "name"],
          },
        ]
      : [],
    attributes: ["id", "title", "class_name", "publisher_id"],
  }).catch(() => []);

  const byId = new Map(books.map((b) => [num(b.id), b.toJSON?.() || b]));

  return jsonItems.map((r) => {
    const b = byId.get(num(r.book_id)) || null;

    // attach a `book` object for frontend convenience
    if (!r.book && b) {
      r.book = {
        id: b.id,
        title: b.title,
        class_name: b.class_name,
        publisher_id: b.publisher_id,
        publisher: b.publisher || null, // {id,name}
      };
    }

    // ensure snapshots exist so PDF never misses
    if (!safeText(r.title_snapshot) && b?.title) r.title_snapshot = b.title;
    if (!safeText(r.class_name_snapshot) && b?.class_name) r.class_name_snapshot = b.class_name;

    const pub = safeText(
      r.publisher_snapshot ||
        publisherNameFromBook(b) ||
        publisherNameFromBook(r?.book) ||
        r?.book?.publisher?.name ||
        ""
    );

    if (!safeText(r.publisher_snapshot) && pub) r.publisher_snapshot = pub;

    return r;
  });
}

/* =========================
   PDF Rendering: Sale Invoice
   ========================= */

async function renderSaleInvoiceToDoc(doc, opts) {
  const { sale, school, companyProfile, items, pdfTitle = "SALE INVOICE", dateStr, layout = {} } =
    opts || {};

  const L = {
    hidePublisher: Boolean(layout?.hidePublisher),
    hideClass: Boolean(layout?.hideClass),
    gridLineWidth: Number(layout?.gridLineWidth || 0.6),
    rowPadX: Number(layout?.rowPadX ?? 4),
    rowPadY: Number(layout?.rowPadY ?? 3),
  };

  const pageLeft = doc.page.margins.left;
  const pageRight = doc.page.width - doc.page.margins.right;
  const contentWidth = pageRight - pageLeft;

  const drawHR = () => {
    doc.save();
    doc.lineWidth(0.7);
    doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).stroke();
    doc.restore();
  };

  const drawTableGrid = (topY, bottomY, Xs, outerLeft, outerRight) => {
    doc.save();
    doc.lineWidth(L.gridLineWidth);
    doc.strokeColor("#000");
    doc
      .moveTo(outerLeft, topY)
      .lineTo(outerRight, topY)
      .lineTo(outerRight, bottomY)
      .lineTo(outerLeft, bottomY)
      .closePath()
      .stroke();
    for (const x of Xs) {
      if (x <= outerLeft || x >= outerRight) continue;
      doc.moveTo(x, topY).lineTo(x, bottomY).stroke();
    }
    doc.restore();
  };

  // ---------- Company Header ----------
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
      lines.push({ text: companyProfile.name, font: "Helvetica-Bold", size: 18 });
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

  // ---------- Title ----------
  doc.font("Helvetica-Bold").fontSize(15).fillColor("#000");
  doc.text(pdfTitle, pageLeft, doc.y, { width: contentWidth, align: "center" });
  doc.moveDown(0.4);

  // ---------- Invoice Meta ----------
  const saleNo = safeText(sale?.sale_no || sale?.id);
  const saleDate = safeText(sale?.sale_date || "-");
  const session = safeText(sale?.academic_session || "-");
  const paymentMode = safeText(sale?.payment_mode || "-");

  const leftW = Math.floor(contentWidth * 0.62);
  const rightX = pageLeft + leftW;
  const rightW = pageRight - rightX;

  const topY = doc.y;

  doc.font("Helvetica-Bold").fontSize(11);
  doc.text(`Invoice No: ${saleNo}`, pageLeft, topY, { width: leftW });

  doc.font("Helvetica").fontSize(9);
  doc.text(`Invoice Date: ${saleDate}`, rightX, topY, { width: rightW, align: "right" });
  doc.text(`Print Date: ${safeText(dateStr)}`, rightX, doc.y + 2, {
    width: rightW,
    align: "right",
  });

  doc.y = topY + 20;
  const drawHR2 = () => {
    doc.save();
    doc.lineWidth(0.7);
    doc.moveTo(pageLeft, doc.y).lineTo(pageRight, doc.y).stroke();
    doc.restore();
  };
  drawHR2();
  doc.moveDown(0.4);

  // ---------- Billed To ----------
  const schoolName = safeText(school?.name || "School");
  const schoolCity = safeText(school?.city || "");
  const schoolEmail = safeText(school?.email || school?.office_email || "");
  const schoolPhone = safeText(school?.phone || school?.phone_primary || "");

  doc.font("Helvetica-Bold").fontSize(10).text("Billed To:", pageLeft, doc.y);
  doc.moveDown(0.1);

  doc.font("Helvetica-Bold").fontSize(10).text(schoolName, pageLeft, doc.y);
  doc.font("Helvetica").fontSize(9);
  if (schoolCity) doc.text(schoolCity, pageLeft, doc.y);
  if (schoolPhone) doc.text(`Phone: ${schoolPhone}`, pageLeft, doc.y);
  if (schoolEmail) doc.text(`Email: ${schoolEmail}`, pageLeft, doc.y);

  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(9);
  doc.text(`Academic Session: ${session}`, pageLeft, doc.y);
  doc.text(`Payment Mode: ${paymentMode}`, pageLeft, doc.y);

  if (sale?.po_no) doc.text(`PO No: ${safeText(sale.po_no)}`, pageLeft, doc.y);
  if (sale?.challan_no) doc.text(`Challan No: ${safeText(sale.challan_no)}`, pageLeft, doc.y);
  if (sale?.due_date) doc.text(`Due Date: ${safeText(sale.due_date)}`, pageLeft, doc.y);

  doc.moveDown(0.4);
  drawHR2();
  doc.moveDown(0.5);

  // ---------- Items Table ----------
  const hidePublisher = L.hidePublisher === true;
  const hideClass = L.hideClass === true;

  // ✅ Safe column sizing so Amount never goes out of page
  let W = {
    sr: 28,
    title: 0, // computed
    class: hideClass ? 0 : 62,
    publisher: hidePublisher ? 0 : 88,
    req: 44,
    issued: 48,
    unit: 60,
    amt: 70,
  };

  const minTitle = 110;

  const fixed =
    W.sr +
    W.req +
    W.issued +
    W.unit +
    W.amt +
    (hideClass ? 0 : W.class) +
    (hidePublisher ? 0 : W.publisher);

  W.title = contentWidth - fixed;

  if (W.title < minTitle) {
    let need = minTitle - W.title;
    W.title = minTitle;

    const shrink = (key, minVal) => {
      const can = Math.max(0, W[key] - minVal);
      const take = Math.min(can, need);
      W[key] -= take;
      need -= take;
    };

    if (!hidePublisher) shrink("publisher", 60);
    if (!hideClass) shrink("class", 50);
    shrink("unit", 50);
    shrink("amt", 55);

    if (need > 0) W.title = Math.max(80, W.title - need);
  }

  const used =
    W.sr +
    W.title +
    W.req +
    W.issued +
    W.unit +
    W.amt +
    (hideClass ? 0 : W.class) +
    (hidePublisher ? 0 : W.publisher);

  if (used > contentWidth) {
    W.title = Math.max(80, W.title - (used - contentWidth));
  }

  const X = { sr: pageLeft, title: pageLeft + W.sr };

  let cursor = X.title + W.title;
  if (!hideClass) {
    X.class = cursor;
    cursor += W.class;
  }
  if (!hidePublisher) {
    X.publisher = cursor;
    cursor += W.publisher;
  }
  X.req = cursor;
  cursor += W.req;
  X.issued = cursor;
  cursor += W.issued;
  X.unit = cursor;
  cursor += W.unit;
  X.amt = cursor;

  const gridXs = (() => {
    const arr = [pageLeft, X.title];
    if (!hideClass) arr.push(X.class);
    if (!hidePublisher) arr.push(X.publisher);
    arr.push(X.req, X.issued, X.unit, X.amt, pageRight);
    return Array.from(new Set(arr)).sort((a, b) => a - b);
  })();

  const printHeader = () => {
    const y = doc.y;
    const h = 20;

    doc.save();
    doc.rect(pageLeft, y, contentWidth, h).fill("#f2f2f2");
    doc.restore();

    doc.fillColor("#000").font("Helvetica-Bold").fontSize(9);
    const padX = L.rowPadX;
    const textY = y + 5;

    doc.text("Sr", X.sr + padX, textY, { width: W.sr - padX * 2 });
    doc.text("Item", X.title + padX, textY, { width: W.title - padX * 2 });

    if (!hideClass) doc.text("Class", X.class + padX, textY, { width: W.class - padX * 2 });
    if (!hidePublisher)
      doc.text("Publisher", X.publisher + padX, textY, { width: W.publisher - padX * 2 });

    doc.text("Req", X.req, textY, { width: W.req, align: "center" });
    doc.text("Issued", X.issued, textY, { width: W.issued, align: "center" });
    doc.text("Rate", X.unit, textY, { width: W.unit - 6, align: "right" });
    doc.text("Amount", X.amt, textY, { width: W.amt - 6, align: "right" });

    drawTableGrid(y, y + h, gridXs, pageLeft, pageRight);
    doc.y = y + h;
  };

  const ensureSpace = (neededHeight) => {
    const bottom = doc.page.height - doc.page.margins.bottom;
    if (doc.y + neededHeight > bottom) {
      doc.addPage();
      if (companyProfile) {
        doc.font("Helvetica-Bold").fontSize(11).text(pdfTitle, pageLeft, doc.y, {
          width: contentWidth,
          align: "center",
        });
        doc.moveDown(0.3);
        drawHR2();
        doc.moveDown(0.4);
      }
      printHeader();
      return true;
    }
    return false;
  };

  printHeader();

  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) {
    doc.font("Helvetica").fontSize(10).text("No items found.", pageLeft, doc.y + 8);
  } else {
    let sr = 1;
    for (let i = 0; i < rows.length; i++) {
      const it = rows[i];

      const title = safeText(it.title_snapshot || it?.book?.title || "Item");
      const className = safeText(it.class_name_snapshot || it?.book?.class_name || "");

      // ✅ Publisher from snapshot OR book.publisher association
      const publisher = safeText(
        it.publisher_snapshot ||
          it?.book?.publisher?.name ||
          it?.book?.publisher_name ||
          it?.book?.publisher ||
          ""
      );

      const reqQty = round2(num(it.requested_qty));
      const issuedQty = round2(num(it.issued_qty));
      const unit = round2(num(it.requested_unit_price));
      const amt = round2(num(it.amount));

      doc.font("Helvetica").fontSize(9);
      const hTitle = doc.heightOfString(title, { width: Math.max(10, W.title - 8) });
      const hClass = hideClass
        ? 0
        : doc.heightOfString(className || "-", { width: Math.max(10, W.class - 8) });
      const hPub = hidePublisher
        ? 0
        : doc.heightOfString(publisher || "-", { width: Math.max(10, W.publisher - 8) });

      const rh = Math.max(hTitle, hClass, hPub, 10) + 8;

      ensureSpace(rh + 2);

      const yTop = doc.y;
      const yBot = yTop + rh;

      const isAlt = sr % 2 === 0;
      if (isAlt) {
        doc.save();
        doc.rect(pageLeft, yTop, contentWidth, rh).fill("#fbfcfe");
        doc.restore();
      }

      const padX = L.rowPadX;
      const textY = yTop + L.rowPadY;

      doc.fillColor("#000").font("Helvetica").fontSize(9);
      doc.text(String(sr), X.sr + padX, textY, { width: W.sr - padX * 2 });
      doc.text(title, X.title + padX, textY, { width: W.title - padX * 2 });

      if (!hideClass)
        doc.text(className || "-", X.class + padX, textY, { width: W.class - padX * 2 });
      if (!hidePublisher)
        doc.text(publisher || "-", X.publisher + padX, textY, { width: W.publisher - padX * 2 });

      doc.font("Helvetica-Bold").fontSize(9);
      doc.text(String(reqQty), X.req, textY, { width: W.req, align: "center" });
      doc.text(String(issuedQty), X.issued, textY, { width: W.issued, align: "center" });
      doc.text(unit.toFixed(2), X.unit, textY, { width: W.unit - 6, align: "right" });
      doc.text(amt.toFixed(2), X.amt, textY, { width: W.amt - 6, align: "right" });

      drawTableGrid(yTop, yBot, gridXs, pageLeft, pageRight);

      doc.y = yBot;
      sr++;
    }
  }

  // ---------- Totals ----------
  doc.moveDown(0.6);
  const subtotal = round2(num(sale?.subtotal));
  const discount = round2(num(sale?.discount));
  const tax = round2(num(sale?.tax));
  const total = round2(num(sale?.total_amount));
  const paid = round2(num(sale?.paid_amount));
  const bal = round2(num(sale?.balance_amount));

  const totalsW = Math.floor(contentWidth * 0.40);
  const totalsX = pageRight - totalsW;

  const line = (label, value, bold = false) => {
    const y = doc.y;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 10 : 9);
    doc.text(label, totalsX, y, { width: totalsW * 0.55, align: "left" });
    doc.text(value, totalsX + totalsW * 0.55, y, { width: totalsW * 0.45, align: "right" });
    doc.y = y + 14;
  };

  drawHR();
  doc.moveDown(0.4);

  line("Subtotal", subtotal.toFixed(2));
  line("Discount", discount.toFixed(2));
  line("Tax", tax.toFixed(2));
  line("Total", total.toFixed(2), true);
  line("Paid", paid.toFixed(2));
  line("Balance", bal.toFixed(2), true);

  if (sale?.notes) {
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(10).text("Notes", pageLeft, doc.y);
    doc.font("Helvetica").fontSize(9).text(safeText(sale.notes), pageLeft, doc.y + 2, {
      width: contentWidth,
    });
  }
}

function buildSalePdfBuffer({ sale, school, companyProfile, items, pdfTitle, dateStr, layout = {} }) {
  return new Promise(async (resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      await renderSaleInvoiceToDoc(doc, {
        sale,
        school,
        companyProfile,
        items,
        pdfTitle,
        dateStr,
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

/* ============================================================
   ✅ Grand totals helper for create responses
   ============================================================ */
function buildGrandAndGroupsSummary({ invoice_group_by, createdSales }) {
  const groups = (createdSales || []).map((s) => {
    const row = s?.toJSON?.() || s;
    const group_key =
      invoice_group_by === "CLASS"
        ? String(row.class_id ?? "0")
        : invoice_group_by === "PUBLISHER"
          ? safeText(row.group_key || row.publisher_key || row.publisher_name || "UNKNOWN_PUBLISHER")
          : "ALL";

    return {
      sale_id: row.id,
      sale_no: row.sale_no,
      group_key,
      subtotal: round2(row.subtotal),
      discount: round2(row.discount),
      tax: round2(row.tax),
      total_amount: round2(row.total_amount),
      paid_amount: round2(row.paid_amount),
      balance_amount: round2(row.balance_amount),
    };
  });

  const grand = {
    subtotal: round2(groups.reduce((s, x) => s + num(x.subtotal), 0)),
    discount: round2(groups.reduce((s, x) => s + num(x.discount), 0)),
    tax: round2(groups.reduce((s, x) => s + num(x.tax), 0)),
    total_amount: round2(groups.reduce((s, x) => s + num(x.total_amount), 0)),
    paid_amount: round2(groups.reduce((s, x) => s + num(x.paid_amount), 0)),
    balance_amount: round2(groups.reduce((s, x) => s + num(x.balance_amount), 0)),
  };

  const byGroup = new Map();
  for (const g of groups) {
    const key = g.group_key || "ALL";
    if (!byGroup.has(key)) {
      byGroup.set(key, { group_key: key, subtotal: 0, discount: 0, tax: 0, total_amount: 0 });
    }
    const agg = byGroup.get(key);
    agg.subtotal = round2(agg.subtotal + num(g.subtotal));
    agg.discount = round2(agg.discount + num(g.discount));
    agg.tax = round2(agg.tax + num(g.tax));
    agg.total_amount = round2(agg.total_amount + num(g.total_amount));
  }

  return { grand, groups, groups_totals: Array.from(byGroup.values()) };
}

/* =========================
   0) PREVIEW FROM REQUIREMENTS (NO DB WRITE)
   ========================= */
exports.previewFromRequirements = async (request, reply) => {
  try {
    enforceSalesAuthorization(request.user);
  } catch (e) {
    return reply.code(e.statusCode || 403).send({ message: e.message });
  }

  const body = request.body || {};
  const school_id = num(body.school_id);
  const academic_session = safeText(body.academic_session || "");
  const class_id = body.class_id != null ? num(body.class_id) : null;
  const supplier_id = body.supplier_id != null ? num(body.supplier_id) : null;

  const invoice_group_by = safeText(body.invoice_group_by || "NONE").toUpperCase();
  const discount_in = round2(num(body.discount));
  const tax_in = round2(num(body.tax));

  if (!school_id) return reply.code(400).send({ message: "school_id is required" });
  if (!academic_session) return reply.code(400).send({ message: "academic_session is required" });

  if (!["NONE", "CLASS", "PUBLISHER"].includes(invoice_group_by)) {
    return reply.code(400).send({ message: "invoice_group_by must be NONE, CLASS, PUBLISHER" });
  }

  try {
    const school = await School.findByPk(school_id);
    if (!school) return reply.code(404).send({ message: "School not found" });

    const whereReq = {
      school_id,
      academic_session,
      status: "confirmed",
      required_copies: { [Op.gt]: 0 },
    };
    if (class_id) whereReq.class_id = class_id;
    if (supplier_id) whereReq.supplier_id = supplier_id;

    const reqRows = await SchoolBookRequirement.findAll({
      where: whereReq,
      include: [
        {
          model: Book,
          as: "book",
          required: false,
          include: Publisher
            ? [{ model: Publisher, as: "publisher", required: false, attributes: ["id", "name"] }]
            : [],
        },
      ],
      order: [["id", "ASC"]],
    });

    if (!reqRows.length) {
      return reply.code(400).send({ message: "No confirmed requirements found for given filters" });
    }

    const bookIds = reqRows.map((r) => num(r.book_id)).filter(Boolean);
    const products = await Product.findAll({ where: { book_id: bookIds } }).catch(() => []);
    const pByBook = new Map(products.map((p) => [num(p.book_id), p]));

    const groupKeyForReq = (r) => {
      if (invoice_group_by === "NONE") return "ALL";
      if (invoice_group_by === "CLASS") return String(num(r.class_id || class_id || 0) || "0");
      if (invoice_group_by === "PUBLISHER") {
        const b = r.book || null;
        const p = pByBook.get(num(r.book_id)) || null;
        const pub = safeText(publisherNameFromBook(b) || p?.publisher_name || p?.publisher || "");
        return pub || "UNKNOWN_PUBLISHER";
      }
      return "ALL";
    };

    const groups = new Map();
    for (const r of reqRows) {
      const k = groupKeyForReq(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }

    const groupKeys = Array.from(groups.keys());
    const groupEst = [];
    let grandSub = 0;

    for (const k of groupKeys) {
      const rows = groups.get(k);
      let s = 0;
      for (const r of rows) {
        const qty = num(r.required_copies);
        if (qty <= 0) continue;

        const book = r.book || null;
        const product = pByBook.get(num(r.book_id)) || null;

        const { unit } = resolveUnitPrice({
          reqRow: r,
          book_id: num(r.book_id),
          book,
          product,
          body,
        });
        s += qty * unit;
      }
      s = round2(s);
      groupEst.push({ key: k, estSubtotal: s });
      grandSub += s;
    }
    grandSub = round2(grandSub);

    const alloc = (totalValue, partValue) => {
      if (grandSub <= 0) return 0;
      return round2((num(totalValue) * num(partValue)) / num(grandSub));
    };

    const previews = [];

    for (let i = 0; i < groupEst.length; i++) {
      const g = groupEst[i];
      const rows = groups.get(g.key);

      let discount = invoice_group_by === "NONE" ? discount_in : alloc(discount_in, g.estSubtotal);
      let tax = invoice_group_by === "NONE" ? tax_in : alloc(tax_in, g.estSubtotal);

      if (invoice_group_by !== "NONE" && i === groupEst.length - 1) {
        const usedD = previews.reduce((s, x) => s + num(x.discount), 0);
        const usedT = previews.reduce((s, x) => s + num(x.tax), 0);
        discount = round2(discount_in - usedD);
        tax = round2(tax_in - usedT);
      }

      const items = [];
      let subtotal = 0;

      for (const r of rows) {
        const book_id = num(r.book_id);
        const reqQty = num(r.required_copies);
        if (!book_id || reqQty <= 0) continue;

        const book = r.book || null;
        const product = pByBook.get(book_id) || null;

        const pricing = resolveUnitPrice({ reqRow: r, book_id, book, product, body });
        const amount = round2(reqQty * pricing.unit);
        subtotal = round2(subtotal + amount);

        const available = round2(
          num(
            await InventoryBatch.sum("available_qty", {
              where: { book_id, available_qty: { [Op.gt]: 0 } },
            })
          )
        );

        const publisher = safeText(
          publisherNameFromBook(book) || product?.publisher_name || product?.publisher || ""
        );

        items.push({
          requirement_item_id: r.id,
          book_id,
          title: safeText(book?.title || product?.name || "Book"),
          class_name: safeText(book?.class_name || product?.class_name || ""),
          publisher,
          requested_qty: reqQty,
          default_unit_price: pricing.defaultUnit,
          unit_price: pricing.unit,
          is_overridden: pricing.isOverridden,
          amount,
          stock_available: available,
          can_fulfill: available >= reqQty,
          short_qty: round2(Math.max(0, reqQty - available)),
        });
      }

      const total_amount = round2(Math.max(0, subtotal - discount + tax));

      previews.push({
        group_key: g.key,
        invoice_group_by,
        subtotal,
        discount,
        tax,
        total_amount,
        items_count: items.length,
        items,
      });
    }

    const groups_totals = previews.map((p) => ({
      group_key: p.group_key,
      subtotal: p.subtotal,
      discount: p.discount,
      tax: p.tax,
      total_amount: p.total_amount,
    }));

    return reply.send({
      success: true,
      school: { id: school.id, name: school.name },
      filters: { school_id, academic_session, class_id, supplier_id, invoice_group_by },
      grand: {
        subtotal: round2(previews.reduce((s, x) => s + num(x.subtotal), 0)),
        discount: round2(previews.reduce((s, x) => s + num(x.discount), 0)),
        tax: round2(previews.reduce((s, x) => s + num(x.tax), 0)),
        total_amount: round2(previews.reduce((s, x) => s + num(x.total_amount), 0)),
      },
      groups_totals,
      previews,
    });
  } catch (err) {
    request.log.error({ err }, "schoolSales previewFromRequirements failed");
    return reply.code(500).send({ message: err?.message || "Internal Server Error" });
  }
};

/* =========================
   1) CREATE FROM REQUIREMENTS
   ========================= */
exports.createFromRequirements = async (request, reply) => {
  try {
    enforceSalesAuthorization(request.user);
  } catch (e) {
    return reply.code(e.statusCode || 403).send({ message: e.message });
  }

  const body = request.body || {};
  const school_id = num(body.school_id);
  const academic_session = safeText(body.academic_session || "");
  const class_id = body.class_id != null ? num(body.class_id) : null;
  const supplier_id = body.supplier_id != null ? num(body.supplier_id) : null;

  const invoice_group_by = safeText(body.invoice_group_by || "NONE").toUpperCase();

  const payment_mode = safeText(body.payment_mode || "CASH").toUpperCase();
  const paid_amount_in = round2(num(body.paid_amount));

  const discount_in = round2(num(body.discount));
  const tax_in = round2(num(body.tax));
  const notes = body.notes != null ? String(body.notes).trim() : null;

  const po_no = body.po_no != null ? safeText(body.po_no) : null;
  const challan_no = body.challan_no != null ? safeText(body.challan_no) : null;
  const due_date = body.due_date != null ? safeText(body.due_date) : null;

  const sale_date = safeText(body.sale_date) || nowISODate();

  if (!school_id) return reply.code(400).send({ message: "school_id is required" });
  if (!academic_session) return reply.code(400).send({ message: "academic_session is required" });

  if (!["NONE", "CLASS", "PUBLISHER"].includes(invoice_group_by)) {
    return reply.code(400).send({ message: "invoice_group_by must be NONE, CLASS, PUBLISHER" });
  }
  if (!["CASH", "UPI", "CARD", "CREDIT", "MIXED"].includes(payment_mode)) {
    return reply
      .code(400)
      .send({ message: "payment_mode must be CASH, UPI, CARD, CREDIT, MIXED" });
  }

  const t = await sequelize.transaction();
  try {
    const school = await School.findByPk(school_id, { transaction: t });
    if (!school) {
      await t.rollback();
      return reply.code(404).send({ message: "School not found" });
    }

    const whereReq = {
      school_id,
      academic_session,
      status: "confirmed",
      required_copies: { [Op.gt]: 0 },
    };
    if (class_id) whereReq.class_id = class_id;
    if (supplier_id) whereReq.supplier_id = supplier_id;

    const reqRows = await SchoolBookRequirement.findAll({
      where: whereReq,
      include: [
        {
          model: Book,
          as: "book",
          required: false,
          include: Publisher
            ? [{ model: Publisher, as: "publisher", required: false, attributes: ["id", "name"] }]
            : [],
        },
      ],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!reqRows.length) {
      await t.rollback();
      return reply.code(400).send({ message: "No confirmed requirements found for given filters" });
    }

    const bookIds = reqRows.map((r) => num(r.book_id)).filter(Boolean);
    const products = await Product.findAll({
      where: { book_id: bookIds },
      transaction: t,
      lock: t.LOCK.UPDATE,
    }).catch(() => []);
    const pByBook = new Map(products.map((p) => [num(p.book_id), p]));

    const groupKeyForReq = (r) => {
      if (invoice_group_by === "NONE") return "ALL";
      if (invoice_group_by === "CLASS") return String(num(r.class_id || class_id || 0) || "0");
      if (invoice_group_by === "PUBLISHER") {
        const b = r.book || null;
        const p = pByBook.get(num(r.book_id)) || null;
        const pub = safeText(publisherNameFromBook(b) || p?.publisher_name || p?.publisher || "");
        return pub || "UNKNOWN_PUBLISHER";
      }
      return "ALL";
    };

    const groups = new Map();
    for (const r of reqRows) {
      const k = groupKeyForReq(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }

    const groupKeys = Array.from(groups.keys());
    const groupEst = [];
    let grandSub = 0;

    for (const k of groupKeys) {
      const rows = groups.get(k);
      let s = 0;
      for (const r of rows) {
        const qty = num(r.required_copies);
        if (qty <= 0) continue;

        const book = r.book || null;
        const product = pByBook.get(num(r.book_id)) || null;

        const { unit } = resolveUnitPrice({
          reqRow: r,
          book_id: num(r.book_id),
          book,
          product,
          body,
        });
        s += qty * unit;
      }
      s = round2(s);
      groupEst.push({ k, estSubtotal: s });
      grandSub += s;
    }
    grandSub = round2(grandSub);

    const allocateProportional = (totalValue, partValue, totalBase) => {
      if (totalBase <= 0) return 0;
      return round2((num(totalValue) * num(partValue)) / num(totalBase));
    };

    const createdSales = [];
    const allShortages = [];

    for (let gi = 0; gi < groupEst.length; gi++) {
      const { k, estSubtotal } = groupEst[gi];
      const reqs = groups.get(k);

      let discount =
        invoice_group_by === "NONE"
          ? discount_in
          : allocateProportional(discount_in, estSubtotal, grandSub);
      let tax =
        invoice_group_by === "NONE"
          ? tax_in
          : allocateProportional(tax_in, estSubtotal, grandSub);
      let paid_amount_slice =
        invoice_group_by === "NONE"
          ? paid_amount_in
          : allocateProportional(paid_amount_in, estSubtotal, grandSub);

      if (invoice_group_by !== "NONE" && gi === groupEst.length - 1) {
        const usedDiscount = createdSales.reduce((s, x) => s + num(x._discountAllocated || 0), 0);
        const usedTax = createdSales.reduce((s, x) => s + num(x._taxAllocated || 0), 0);
        const usedPaid = createdSales.reduce((s, x) => s + num(x._paidAllocated || 0), 0);

        discount = round2(discount_in - usedDiscount);
        tax = round2(tax_in - usedTax);
        paid_amount_slice = round2(paid_amount_in - usedPaid);
      }

      const sale_no = await generateUniqueSaleNo(t);
      const headerClassId = invoice_group_by === "CLASS" ? num(k) || null : class_id || null;

      const saleCreateObj = {
        sale_no,
        sale_date,
        school_id,
        academic_session,
        class_id: headerClassId,
        supplier_id: supplier_id || null,

        invoice_group_by,
        status: "COMPLETED",

        subtotal: 0,
        discount,
        tax,
        total_amount: 0,

        payment_mode,
        paid_amount: 0,
        balance_amount: 0,

        po_no,
        challan_no,
        due_date,

        notes,
        created_by: request.user?.id || null,
      };

      if ("group_key" in SchoolSale.rawAttributes) saleCreateObj.group_key = String(k);

      const sale = await SchoolSale.create(saleCreateObj, { transaction: t });

      const outTxns = [];
      const itemsToCreate = [];
      let subtotal = 0;

      for (const r of reqs) {
        const book_id = num(r.book_id);
        const reqQty = num(r.required_copies);
        if (!book_id || reqQty <= 0) continue;

        const book = r.book || null;
        const product = pByBook.get(book_id) || null;

        const title_snapshot = safeText(book?.title) || safeText(product?.name) || "Book";
        const class_name_snapshot =
          safeText(book?.class_name) || safeText(product?.class_name) || null;

        // ✅ publisher snapshot from Book.publisher association first
        const publisher_snapshot =
          safeText(publisherNameFromBook(book)) ||
          safeText(product?.publisher_name || product?.publisher || "") ||
          (invoice_group_by === "PUBLISHER" ? safeText(k) : null) ||
          null;

        const pricing = resolveUnitPrice({ reqRow: r, book_id, book, product, body });
        const unit = pricing.unit;

        const { allocations } = await allocateFromBatches({
          book_id,
          qtyNeeded: reqQty,
          t,
          lock: true,
        });
        const issued_qty = round2(allocations.reduce((s, a) => s + num(a.qty), 0));
        const short_qty = round2(Math.max(0, reqQty - issued_qty));

        for (const a of allocations) {
          const q = num(a.qty);
          outTxns.push({
            txn_type: TXN_TYPE.OUT,
            book_id,
            batch_id: num(a.batch_id),
            qty: q,
            ref_type: "SCHOOL_SALE",
            ref_id: sale.id,
            notes: `SchoolSale ${sale_no} (req:${r.id}) -> ${title_snapshot}`,
          });

          await InventoryBatch.update(
            { available_qty: sequelize.literal(`available_qty - ${q}`) },
            { where: { id: num(a.batch_id) }, transaction: t }
          );
        }

        if (short_qty > 0) {
          allShortages.push({
            sale_id: sale.id,
            sale_no,
            requirement_item_id: r.id,
            book_id,
            title: title_snapshot,
            requested: reqQty,
            issued: issued_qty,
            short: short_qty,
            group_key: k,
          });
        }

        const amount = round2(reqQty * unit);
        subtotal = round2(subtotal + amount);

        itemsToCreate.push({
          school_sale_id: sale.id,
          requirement_item_id: r.id,

          product_id: product ? num(product.id) : null,
          book_id,
          kind: "BOOK",

          title_snapshot,
          class_name_snapshot,
          publisher_snapshot,

          requested_qty: reqQty,
          requested_unit_price: unit,
          amount,

          issued_qty,
          short_qty,
        });
      }

      if (!itemsToCreate.length) {
        await t.rollback();
        return reply.code(400).send({ message: "No valid requirement rows to sell" });
      }

      const total_amount = round2(Math.max(0, subtotal - discount + tax));
      const paid_amount = round2(Math.min(total_amount, Math.max(0, paid_amount_slice)));
      const balance_amount = round2(Math.max(0, total_amount - paid_amount));

      await SchoolSaleItem.bulkCreate(itemsToCreate, { transaction: t });
      if (outTxns.length) await InventoryTxn.bulkCreate(outTxns, { transaction: t });

      await sale.update({ subtotal, total_amount, paid_amount, balance_amount }, { transaction: t });

      sale._discountAllocated = discount;
      sale._taxAllocated = tax;
      sale._paidAllocated = paid_amount_slice;

      createdSales.push(sale);
    }

    await t.commit();

    const summary = buildGrandAndGroupsSummary({ invoice_group_by, createdSales });

    return reply.send({
      message: allShortages.length
        ? "School sale invoice(s) created (partial stock for some items)"
        : "School sale invoice(s) created",
      count: createdSales.length,
      invoice_group_by,
      grand: summary.grand,
      groups_totals: summary.groups_totals,
      invoices: summary.groups,
      shortages: allShortages,
    });
  } catch (err) {
    request.log.error({ err }, "schoolSales createFromRequirements failed");
    await t.rollback();
    return reply.code(500).send({ message: err?.message || "Internal Server Error" });
  }
};

/* =========================
   2) GET ONE (✅ FIXED: publisher + book attach)
   ========================= */
exports.getOne = async (request, reply) => {
  const id = num(request.params?.id);
  if (!id) return reply.code(400).send({ message: "Invalid id" });

  try {
    const sale = await SchoolSale.findByPk(id);
    if (!sale) return reply.code(404).send({ message: "School sale not found" });

    try {
      enforceSaleOwnershipOrAdmin(request.user, sale);
    } catch (e) {
      return reply.code(e.statusCode || 403).send({ message: e.message });
    }

    const itemsRaw = await SchoolSaleItem.findAll({
      where: { school_sale_id: id },
      order: [["id", "ASC"]],
    });

    const items = await enrichSaleItems(itemsRaw);

    const school = sale.school_id ? await School.findByPk(sale.school_id).catch(() => null) : null;
    const soldByUser =
      User && sale.created_by ? await User.findByPk(sale.created_by).catch(() => null) : null;

    return reply.send({
      sale: { ...sale.toJSON(), items },
      school,
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
    request.log.error({ err }, "schoolSales getOne failed");
    return reply.code(500).send({ message: err?.message || "Internal Server Error" });
  }
};

/* =========================
   3) LIST
   ========================= */
exports.list = async (request, reply) => {
  try {
    enforceSalesAuthorization(request.user);
  } catch (e) {
    return reply.code(e.statusCode || 403).send({ message: e.message });
  }

  try {
    const q = request.query || {};
    const limit = Math.min(500, Math.max(1, num(q.limit) || 200));

    const where = {};
    if (q.status) where.status = safeText(q.status).toUpperCase();
    if (q.school_id) where.school_id = num(q.school_id);
    if (q.payment_mode) where.payment_mode = safeText(q.payment_mode).toUpperCase();
    if (q.academic_session) where.academic_session = safeText(q.academic_session);

    if (q.date_from || q.date_to) {
      where.sale_date = {};
      if (q.date_from) where.sale_date[Op.gte] = safeText(q.date_from);
      if (q.date_to) where.sale_date[Op.lte] = safeText(q.date_to);
    }

    if (q.q) {
      const s = safeText(q.q);
      where[Op.or] = [
        { sale_no: { [Op.like]: `%${s}%` } },
        { po_no: { [Op.like]: `%${s}%` } },
        { challan_no: { [Op.like]: `%${s}%` } },
      ];
    }

    if (!isAdminish(request.user) && isDistributorUser(request.user)) {
      where.created_by = num(request.user?.id);
    }

    const rows = await SchoolSale.findAll({
      where,
      order: [["id", "DESC"]],
      limit,
    });

    return reply.send({ rows });
  } catch (err) {
    request.log.error({ err }, "schoolSales list failed");
    return reply.code(500).send({ message: err?.message || "Internal Server Error" });
  }
};

/* =========================
   4) CANCEL
   ========================= */
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
    const sale = await SchoolSale.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!sale) {
      await t.rollback();
      return reply.code(404).send({ message: "School sale not found" });
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
      where: { ref_type: "SCHOOL_SALE", ref_id: sale.id, txn_type: TXN_TYPE.OUT },
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
          ref_type: "SCHOOL_SALE_CANCEL",
          ref_id: sale.id,
          notes: `Cancel school sale ${sale.sale_no || sale.id} -> stock revert`,
        });
      }
      await InventoryTxn.bulkCreate(inTxns, { transaction: t });
    }

    await safeSaleUpdate(
      sale,
      { status: "CANCELLED", cancelled_at: new Date(), cancelled_by: request.user?.id || null },
      t
    );

    await t.commit();

    return reply.send({
      message: byBatch.size
        ? "School sale cancelled (stock reverted)"
        : "School sale cancelled (no stock deducted)",
      school_sale_id: sale.id,
      sale_no: sale.sale_no,
      reverted: {
        batches: Array.from(byBatch.entries()).map(([batch_id, qty]) => ({ batch_id, qty })),
      },
    });
  } catch (err) {
    request.log.error({ err }, "schoolSales cancel failed");
    await t.rollback();
    return reply.code(500).send({ message: err?.message || "Internal Server Error" });
  }
};

/* ============================================================
   GET /api/school-sales/:id/pdf  (✅ FIXED: enrich items)
   ============================================================ */
exports.printSalePdf = async (request, reply) => {
  const id = num(request.params?.id);
  if (!id) return reply.code(400).send({ message: "Invalid id" });

  try {
    const sale = await SchoolSale.findByPk(id);
    if (!sale) return reply.code(404).send({ message: "School sale not found" });

    try {
      enforceSaleOwnershipOrAdmin(request.user, sale);
    } catch (e) {
      return reply.code(e.statusCode || 403).send({ message: e.message });
    }

    const itemsRaw = await SchoolSaleItem.findAll({
      where: { school_sale_id: id },
      order: [["id", "ASC"]],
    });

    const items = await enrichSaleItems(itemsRaw);

    const school = sale.school_id ? await School.findByPk(sale.school_id).catch(() => null) : null;

    const companyProfile = await CompanyProfile.findOne({
      where: { is_active: true },
      order: [["is_default", "DESC"], ["id", "ASC"]],
    });

    const today = new Date();
    const dateStr = today.toLocaleDateString("en-IN");

    const pdfBuffer = await buildSalePdfBuffer({
      sale: sale.toJSON(),
      school: school ? (school.toJSON?.() || school) : null,
      companyProfile: companyProfile ? (companyProfile.toJSON?.() || companyProfile) : null,
      items,
      pdfTitle: "SALE INVOICE",
      dateStr,
      layout: { hidePublisher: false, hideClass: false },
    });

    const safeNo = String(sale.sale_no || `sale-${sale.id}`).replace(/[^\w\-]+/g, "_");
    reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `inline; filename="sale-invoice-${safeNo}.pdf"`)
      .send(pdfBuffer);
    return reply;
  } catch (err) {
    request.log.error({ err }, "Error in printSalePdf");
    return reply.code(500).send({ message: err?.message || "Failed to generate PDF" });
  }
};

/* ============================================================
   GET /api/school-sales/pdf/all  (✅ FIXED: enrich items)
   ============================================================ */
exports.printAllSalesPdf = async (request, reply) => {
  try {
    enforceSalesAuthorization(request.user);
  } catch (e) {
    return reply.code(e.statusCode || 403).send({ message: e.message });
  }

  try {
    const q = request.query || {};
    const where = {};

    if (q.status) where.status = safeText(q.status).toUpperCase();
    if (q.school_id) where.school_id = num(q.school_id);
    if (q.payment_mode) where.payment_mode = safeText(q.payment_mode).toUpperCase();
    if (q.academic_session) where.academic_session = safeText(q.academic_session);

    if (q.date_from || q.date_to) {
      where.sale_date = {};
      if (q.date_from) where.sale_date[Op.gte] = safeText(q.date_from);
      if (q.date_to) where.sale_date[Op.lte] = safeText(q.date_to);
    }

    if (q.q) {
      const s = safeText(q.q);
      where[Op.or] = [
        { sale_no: { [Op.like]: `%${s}%` } },
        { po_no: { [Op.like]: `%${s}%` } },
        { challan_no: { [Op.like]: `%${s}%` } },
      ];
    }

    if (!isAdminish(request.user) && isDistributorUser(request.user)) {
      where.created_by = num(request.user?.id);
    }

    const rows = await SchoolSale.findAll({
      where,
      order: [["id", "DESC"]],
      limit: Math.min(500, Math.max(1, num(q.limit) || 200)),
    });

    const companyProfile = await CompanyProfile.findOne({
      where: { is_active: true },
      order: [["is_default", "DESC"], ["id", "ASC"]],
    });

    const today = new Date();
    const dateStr = today.toLocaleDateString("en-IN");

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));

    const bufPromise = new Promise((resolve, reject) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });

    if (!rows.length) {
      doc.font("Helvetica-Bold").fontSize(16).text("No sale invoices found for selected filters.");
      doc.end();
      const pdfBuffer = await bufPromise;

      const fname = `all-sale-invoices-${dateStr.replace(/[^\d]+/g, "-")}.pdf`;
      reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `inline; filename="${fname}"`)
        .send(pdfBuffer);
      return reply;
    }

    for (let i = 0; i < rows.length; i++) {
      const sale = rows[i];
      if (i > 0) doc.addPage();

      const itemsRaw = await SchoolSaleItem.findAll({
        where: { school_sale_id: sale.id },
        order: [["id", "ASC"]],
      }).catch(() => []);

      const items = await enrichSaleItems(itemsRaw);

      const school = sale.school_id ? await School.findByPk(sale.school_id).catch(() => null) : null;

      await renderSaleInvoiceToDoc(doc, {
        sale: sale.toJSON?.() || sale,
        school: school ? (school.toJSON?.() || school) : null,
        companyProfile: companyProfile ? (companyProfile.toJSON?.() || companyProfile) : null,
        items,
        pdfTitle: "SALE INVOICE",
        dateStr,
      });
    }

    doc.end();
    const pdfBuffer = await bufPromise;

    const fname = `all-sale-invoices-${dateStr.replace(/[^\d]+/g, "-")}.pdf`;
    reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `inline; filename="${fname}"`)
      .send(pdfBuffer);

    return reply;
  } catch (err) {
    request.log.error({ err }, "Error in printAllSalesPdf");
    return reply.code(500).send({ message: err?.message || "Failed to generate bulk PDF" });
  }
};

/* ============================================================
   GET /api/school-sales/:id/email-preview
   ============================================================ */
exports.getSaleEmailPreview = async (request, reply) => {
  const id = num(request.params?.id);
  if (!id) return reply.code(400).send({ message: "Invalid id" });

  try {
    const sale = await SchoolSale.findByPk(id);
    if (!sale) return reply.code(404).send({ message: "School sale not found" });

    try {
      enforceSaleOwnershipOrAdmin(request.user, sale);
    } catch (e) {
      return reply.code(e.statusCode || 403).send({ message: e.message });
    }

    const school = sale.school_id ? await School.findByPk(sale.school_id).catch(() => null) : null;

    const companyProfile = await CompanyProfile.findOne({
      where: { is_active: true },
      order: [["is_default", "DESC"], ["id", "ASC"]],
    });

    const cp = companyProfile ? companyProfile.toJSON?.() || companyProfile : null;
    const cpName = cp?.name || "Sumeet Book Store";
    const cpEmail =
      cp?.email ||
      process.env.ORDER_SUPPORT_EMAIL ||
      process.env.SMTP_FROM ||
      process.env.SMTP_USER ||
      "";

    const schoolEmail = safeText(school?.email || school?.office_email || "");
    const schoolName = safeText(school?.name || "School");

    const saleNo = safeText(sale.sale_no || sale.id);
    const saleDate = safeText(sale.sale_date || "-");

    const subject = `Sale Invoice – ${saleNo} – ${schoolName}`;
    const ccDefault = process.env.SALE_EMAIL_CC || process.env.SMTP_USER || "";

    const html = `
      <p>Dear ${schoolName},</p>
      <p>Please find the attached <strong>Sale Invoice PDF</strong>.</p>
      <div><strong>Invoice No:</strong> ${saleNo}</div>
      <div><strong>Invoice Date:</strong> ${saleDate}</div>
      <p style="margin-top:16px;">
        Regards,<br/>
        <strong>${cpName}</strong><br/>
        ${cpEmail ? `Email: ${cpEmail}<br/>` : ""}
      </p>
    `;

    return reply.code(200).send({
      sale_invoice_id: sale.id,
      sale_no: saleNo,
      to: schoolEmail,
      cc: ccDefault,
      subject,
      html,
      replyTo: cpEmail || null,
    });
  } catch (err) {
    request.log.error({ err }, "Error in getSaleEmailPreview");
    return reply.code(500).send({ message: err?.message || "Failed to build email preview" });
  }
};

/* ============================================================
   GET /api/school-sales/:id/email-logs?limit=20
   ============================================================ */
exports.getSaleEmailLogs = async (request, reply) => {
  const id = num(request.params?.id);
  const limit = Math.min(Number(request.query?.limit || 20) || 20, 50);

  try {
    const Log = getSaleEmailLogModel();
    if (!Log) return reply.code(200).send({ data: [] });

    const rows = await Log.findAll({
      where: { sale_invoice_id: Number(id) },
      order: [["sent_at", "DESC"]],
      limit,
    });

    return reply.code(200).send({ data: rows });
  } catch (err) {
    request.log.error({ err }, "Error in getSaleEmailLogs");
    return reply.code(500).send({ message: err?.message || "Failed to load email logs" });
  }
};

/* ============================================================
   GET /api/school-sales/email-logs?limit=100&q=
   ============================================================ */
exports.getAllSaleEmailLogs = async (request, reply) => {
  const limit = Math.min(Number(request.query?.limit || 100) || 100, 500);
  const q = String(request.query?.q || "").trim();

  try {
    const Log = getSaleEmailLogModel();
    if (!Log) return reply.code(200).send({ data: [] });

    const where = {};
    if (q) {
      where[Op.or] = [
        { to_email: { [Op.like]: `%${q}%` } },
        { cc_email: { [Op.like]: `%${q}%` } },
        { subject: { [Op.like]: `%${q}%` } },
      ];
    }

    const rows = await Log.findAll({
      where,
      order: [["sent_at", "DESC"]],
      limit,
    });

    return reply.code(200).send({ data: rows });
  } catch (err) {
    request.log.error({ err }, "Error in getAllSaleEmailLogs");
    return reply.code(500).send({ message: err?.message || "Failed to load global email logs" });
  }
};

/* ============================================================
   POST /api/school-sales/:id/send-email
   body: { to, cc, subject, html }
   ============================================================ */
exports.sendSaleInvoiceEmail = async (request, reply) => {
  const id = num(request.params?.id);
  if (!id) return reply.code(400).send({ message: "Invalid id" });

  let { to, cc, subject, html } = request.body || {};
  to = normalizeEmailList(to);
  cc = normalizeEmailList(cc);

  try {
    const sale = await SchoolSale.findByPk(id);
    if (!sale) return reply.code(404).send({ message: "School sale not found" });

    try {
      enforceSaleOwnershipOrAdmin(request.user, sale);
    } catch (e) {
      return reply.code(e.statusCode || 403).send({ message: e.message });
    }

    const itemsRaw = await SchoolSaleItem.findAll({
      where: { school_sale_id: sale.id },
      order: [["id", "ASC"]],
    });

    const items = await enrichSaleItems(itemsRaw);

    const school = sale.school_id ? await School.findByPk(sale.school_id).catch(() => null) : null;
    if (!school) return reply.code(400).send({ message: "School not linked with this sale." });

    if (!to) to = safeText(school.email || school.office_email || "");
    if (!to) return reply.code(400).send({ message: `School email not set for "${school.name}".` });

    if (!validateEmailList(to)) return reply.code(400).send({ message: "Invalid To email(s)." });
    if (cc && !validateEmailList(cc))
      return reply.code(400).send({ message: "Invalid CC email(s)." });

    const companyProfile = await CompanyProfile.findOne({
      where: { is_active: true },
      order: [["is_default", "DESC"], ["id", "ASC"]],
    });

    const cp = companyProfile ? companyProfile.toJSON?.() || companyProfile : null;
    const cpName = cp?.name || "Sumeet Book Store";
    const cpPhone = cp?.phone_primary || "";
    const cpEmail =
      cp?.email ||
      process.env.ORDER_SUPPORT_EMAIL ||
      process.env.SMTP_FROM ||
      process.env.SMTP_USER ||
      "";

    const today = new Date();
    const todayStr = today.toLocaleDateString("en-IN");

    const schoolName = safeText(school.name || "School");
    const saleNo = safeText(sale.sale_no || sale.id);
    const saleDate = safeText(sale.sale_date || "-");

    if (!subject || !String(subject).trim()) subject = `Sale Invoice – ${saleNo} – ${schoolName}`;
    subject = String(subject).trim();

    if (!html || !String(html).trim()) {
      html = `
        <p>Dear ${schoolName},</p>
        <p>Please find the attached <strong>Sale Invoice PDF</strong>.</p>
        <div><strong>Invoice No:</strong> ${saleNo}</div>
        <div><strong>Invoice Date:</strong> ${saleDate}</div>
        <p style="margin-top:16px;">
          Regards,<br/>
          <strong>${cpName}</strong><br/>
          ${cpPhone ? `Phone: ${cpPhone}<br/>` : ""}
          ${cpEmail ? `Email: ${cpEmail}<br/>` : ""}
        </p>
      `;
    }

    const pdfBuffer = await buildSalePdfBuffer({
      sale: sale.toJSON?.() || sale,
      school: school.toJSON?.() || school,
      companyProfile: cp,
      items,
      pdfTitle: "SALE INVOICE",
      dateStr: todayStr,
      layout: { hidePublisher: false, hideClass: false },
    });

    const filename = `sale-invoice-${String(saleNo).replace(/[^\w\-]+/g, "_")}.pdf`;

    const info = await sendMail({
      to,
      cc: cc || undefined,
      subject,
      html,
      replyTo: cpEmail || undefined,
      attachments: [{ filename, content: pdfBuffer, contentType: "application/pdf" }],
    });

    try {
      const patch = {
        status: sale.status,
        last_email_sent_at: new Date(),
        last_email_to: to,
        last_email_cc: cc || null,
        last_email_subject: subject,
        email_sent_count: (num(sale.email_sent_count) || 0) + 1,
      };
      await safeSaleUpdate(sale, patch, null);
    } catch {}

    try {
      const Log = getSaleEmailLogModel();
      if (Log) {
        await Log.create({
          sale_invoice_id: sale.id,
          to_email: to,
          cc_email: cc || null,
          subject: subject,
          message_id: info?.messageId || null,
          group_id: info?.groupId || null,
          recipient_type: "to",
          status: "SENT",
          sent_at: new Date(),
          meta: { response: info?.response || null },
        });
      }
    } catch {}

    return reply.code(200).send({
      message: "Sale invoice email (with PDF) sent successfully.",
      sale_invoice_id: sale.id,
      sale_no: saleNo,
      to,
      cc: cc || null,
      message_id: info?.messageId || null,
    });
  } catch (err) {
    try {
      const Log = getSaleEmailLogModel();
      if (Log) {
        await Log.create({
          sale_invoice_id: Number(id),
          to_email: to || "",
          cc_email: cc || null,
          subject: String(subject || "Sale Invoice").slice(0, 255),
          recipient_type: "unknown",
          status: "FAILED",
          sent_at: new Date(),
          error_message: err?.message || String(err),
        });
      }
    } catch {}

    request.log.error({ err }, "sendSaleInvoiceEmail failed");
    return reply.code(500).send({ message: err?.message || "Failed to send sale invoice email" });
  }
};

/* =========================
   5) UPDATE SALE (HEADER + ITEMS)
   PUT /api/school-sales/:id
   ========================= */
exports.updateSale = async (request, reply) => {
  const id = num(request.params?.id);
  if (!id) return reply.code(400).send({ message: "Invalid id" });

  try {
    enforceSalesAuthorization(request.user);
  } catch (e) {
    return reply.code(e.statusCode || 403).send({ message: e.message });
  }

  const body = request.body || {};
  const t = await sequelize.transaction();

  try {
    const sale = await SchoolSale.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!sale) {
      await t.rollback();
      return reply.code(404).send({ message: "School sale not found" });
    }

    try {
      enforceSaleOwnershipOrAdmin(request.user, sale);
    } catch (e) {
      await t.rollback();
      return reply.code(e.statusCode || 403).send({ message: e.message });
    }

    if (String(sale.status || "").toUpperCase() === "CANCELLED") {
      await t.rollback();
      return reply.code(400).send({ message: "Cancelled sale cannot be updated" });
    }

    const patch = {
      sale_no: body.sale_no != null ? safeText(body.sale_no) : undefined,
      sale_date: body.sale_date != null ? safeText(body.sale_date) : undefined,
      payment_mode: body.payment_mode != null ? safeText(body.payment_mode).toUpperCase() : undefined,
      paid_amount: body.paid_amount != null ? round2(num(body.paid_amount)) : undefined,
      discount: body.discount != null ? round2(num(body.discount)) : undefined,
      tax: body.tax != null ? round2(num(body.tax)) : undefined,
      notes: body.notes != null ? String(body.notes).trim() : undefined,
      po_no: body.po_no != null ? safeText(body.po_no) : undefined,
      challan_no: body.challan_no != null ? safeText(body.challan_no) : undefined,
      due_date: body.due_date != null ? safeText(body.due_date) : undefined,
    };

    if (
      patch.payment_mode &&
      !["CASH", "UPI", "CARD", "CREDIT", "MIXED"].includes(patch.payment_mode)
    ) {
      await t.rollback();
      return reply
        .code(400)
        .send({ message: "payment_mode must be CASH, UPI, CARD, CREDIT, MIXED" });
    }

    Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);
    await safeSaleUpdate(sale, patch, t);

    if (Array.isArray(body.items)) {
      const dbItems = await SchoolSaleItem.findAll({
        where: { school_sale_id: id },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      const byId = new Map(dbItems.map((x) => [Number(x.id), x]));

      for (const it of body.items) {
        const itemId = Number(it?.id);
        if (!itemId) continue;

        const row = byId.get(itemId);
        if (!row) continue;

        const nextQty =
          it.requested_qty != null ? Math.max(0, Math.floor(num(it.requested_qty))) : undefined;

        const nextRate =
          it.requested_unit_price != null ? round2(num(it.requested_unit_price)) : undefined;

        const itemPatch = {};
        if (nextQty !== undefined) itemPatch.requested_qty = nextQty;
        if (nextRate !== undefined) itemPatch.requested_unit_price = nextRate;

        if (nextQty !== undefined || nextRate !== undefined) {
          const q = nextQty !== undefined ? nextQty : num(row.requested_qty);
          const r = nextRate !== undefined ? nextRate : num(row.requested_unit_price);
          itemPatch.amount = round2(q * r);
        }

        if (Object.keys(itemPatch).length) {
          await row.update(itemPatch, { transaction: t });
        }
      }

      const freshItems = await SchoolSaleItem.findAll({
        where: { school_sale_id: id },
        transaction: t,
      });
      const subtotal = round2(freshItems.reduce((s, x) => s + round2(num(x.amount)), 0));

      const discount = round2(num(sale.discount));
      const tax = round2(num(sale.tax));
      const total_amount = round2(Math.max(0, subtotal - discount + tax));

      let paid_amount = round2(num(sale.paid_amount));
      if (paid_amount > total_amount) paid_amount = total_amount;
      if (paid_amount < 0) paid_amount = 0;

      const balance_amount = round2(Math.max(0, total_amount - paid_amount));

      await safeSaleUpdate(sale, { subtotal, total_amount, paid_amount, balance_amount }, t);
    } else {
      const subtotal = round2(num(sale.subtotal));
      const discount = round2(num(sale.discount));
      const tax = round2(num(sale.tax));
      const total_amount = round2(Math.max(0, subtotal - discount + tax));

      let paid_amount = round2(num(sale.paid_amount));
      if (paid_amount > total_amount) paid_amount = total_amount;
      if (paid_amount < 0) paid_amount = 0;

      const balance_amount = round2(Math.max(0, total_amount - paid_amount));

      await safeSaleUpdate(sale, { total_amount, paid_amount, balance_amount }, t);
    }

    await t.commit();

    const finalSale = await SchoolSale.findByPk(id, {
      include: [{ model: SchoolSaleItem, as: "items" }],
    });

    const finalJson = finalSale?.toJSON?.() || finalSale || (sale.toJSON?.() || sale);
    if (finalJson?.items) finalJson.items = await enrichSaleItems(finalJson.items);

    return reply.send({
      message: "Sale updated",
      sale: finalJson,
    });
  } catch (err) {
    request.log.error({ err }, "schoolSales updateSale failed");
    await t.rollback();
    return reply.code(500).send({ message: err?.message || "Internal Server Error" });
  }
};