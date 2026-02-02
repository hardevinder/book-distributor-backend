"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const PDFDocument = require("pdfkit");

const { Op } = require("sequelize");

const {
  Bundle,
  BundleItem,
  BundleIssue,
  InventoryBatch,
  InventoryTxn,
  School,
  Distributor,
  Product,
  Book,

  // optional (if exists in your models index)
  CompanyProfile,
  Transport,

  sequelize,
} = require("../models");

/* ---------------- Helpers ---------------- */

const TXN_TYPE = {
  IN: "IN",
  RESERVE: "RESERVE",
  UNRESERVE: "UNRESERVE",
  OUT: "OUT",
};

const ADMINISH_ROLES = ["ADMIN", "SUPERADMIN", "OWNER", "STAFF", "ACCOUNTANT"];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n) => Math.round(num(n) * 100) / 100;

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

function safeText(v) {
  return String(v ?? "").trim();
}

function makeIssueNo() {
  return (
    "BI" +
    Math.random()
      .toString(36)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6)
  );
}

/** roles can be: user.role, user.roles (array), etc */
function getUserRoles(user) {
  const r = user?.roles ?? user?.role ?? [];
  if (Array.isArray(r)) return r.map((x) => String(x).toUpperCase());
  return [String(r).toUpperCase()];
}

function hasRole(user, role) {
  const roles = getUserRoles(user);
  return roles.includes(String(role).toUpperCase());
}

function isAdminish(user) {
  const roles = getUserRoles(user);
  return ADMINISH_ROLES.some((r) => roles.includes(r));
}

function isDistributorUser(user) {
  return hasRole(user, "DISTRIBUTOR");
}

function getDistributorIdFromUser(user) {
  return (
    Number(user?.distributor_id || user?.distributorId || user?.DistributorId || 0) || 0
  );
}

/**
 * ✅ Authorization:
 * - Admin-ish can issue to ANY (SCHOOL/DISTRIBUTOR) and see/cancel all
 * - Distributor user can issue ONLY to self distributor_id and see/cancel only own issues
 */
function enforceIssuerAuthorization({ user, issued_to_type, issued_to_id }) {
  const admin = isAdminish(user);
  const distUser = isDistributorUser(user);

  if (admin) return { issued_to_type, issued_to_id };

  if (distUser) {
    const myDid = getDistributorIdFromUser(user);
    if (!myDid) {
      const err = new Error("Distributor user is not linked with any distributor_id");
      err.statusCode = 403;
      throw err;
    }

    if (
      String(issued_to_type).toUpperCase() !== "DISTRIBUTOR" ||
      Number(issued_to_id) !== Number(myDid)
    ) {
      const err = new Error("Not allowed: distributor can issue only to own distributor_id");
      err.statusCode = 403;
      throw err;
    }

    return { issued_to_type: "DISTRIBUTOR", issued_to_id: myDid };
  }

  const err = new Error("Not authorized to issue bundles");
  err.statusCode = 403;
  throw err;
}

/**
 * ✅ FIFO allocation from available batches
 * returns allocations for as much as possible + remaining (shortage)
 */
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

/**
 * ✅ Product -> Book id resolver (supports multiple schemas)
 */
function resolveBookIdFromProduct(p) {
  if (!p) return 0;

  const direct = num(p.book_id) || num(p.bookId) || num(p.BookId) || 0;
  if (direct) return direct;

  const nested = num(p.book?.id) || 0;
  if (nested) return nested;

  return 0;
}

/**
 * ✅ Normalize product type
 */
function normalizeProductType(p) {
  return String(p?.type || "BOOK").toUpperCase();
}

/**
 * ✅ Resolve rate/price for UI summary
 * Priority: bundleItem fields → product fields
 */
function resolveRateFromItemProduct(bundleItem, product) {
  // ✅ Priority: bundleItem fields first (because you store custom pricing here)
  const r =
    num(bundleItem?.sale_price) ||
    num(bundleItem?.selling_price) ||
    num(bundleItem?.unit_price) ||
    num(bundleItem?.rate) ||
    num(bundleItem?.price) ||
    0;

  if (r) return r;

  // ✅ fallback to product pricing
  return (
    num(product?.selling_price) ||
    num(product?.sale_price) ||
    num(product?.rate) ||
    num(product?.mrp) ||
    num(product?.price) ||
    0
  );
}

/* ---------------- Notes helpers (human friendly) ---------------- */

function extractMetaFromRemarks(remarks) {
  const s = String(remarks || "");
  const idx = s.indexOf("__META__=");
  if (idx === -1) return { note: s.trim() || null, meta: null };

  const note = s.slice(0, idx).trim() || null;
  const jsonPart = s.slice(idx + "__META__=".length).trim();

  try {
    return { note, meta: JSON.parse(jsonPart) };
  } catch {
    return { note, meta: null };
  }
}

function formatMetaForHumans(meta) {
  if (!meta || typeof meta !== "object") return null;

  const lines = [];

  const status = String(meta.computed_status || "").toUpperCase();
  if (status) lines.push(`Status: ${status}`);

  if (meta.totalIssuedNow != null && meta.totalRequested != null) {
    lines.push(`Issued: ${meta.totalIssuedNow}/${meta.totalRequested} (books)`);
  }

  if (Array.isArray(meta.shortages) && meta.shortages.length) {
    lines.push("");
    lines.push("Pending (out of stock):");
    for (const s of meta.shortages) {
      const title = s?.title || "Unknown";
      const shortBy = num(s?.shortBy);
      lines.push(`- ${title} (short ${shortBy})`);
    }
  }

  if (Array.isArray(meta.non_book_items) && meta.non_book_items.length) {
    lines.push("");
    lines.push("Non-book items (no inventory deduction):");
    for (const n of meta.non_book_items) {
      const title = n?.title || "Unknown";
      const type = String(n?.type || "MATERIAL");
      lines.push(`- ${title} (${type})`);
    }
  }

  const issuedAmt = num(meta?.totals?.issued_amount);
  const reservedAmt = num(meta?.totals?.reserved_amount);
  const totalAmt = num(meta?.totals?.total_amount);

  if (issuedAmt || reservedAmt || totalAmt) {
    lines.push("");
    lines.push(`Amount: issued ₹${issuedAmt} / reserved ₹${reservedAmt} / total ₹${totalAmt}`);
  }

  return lines.join("\n");
}

/**
 * ✅ Frontend expects item rows for table.
 * We'll generate item_rows with:
 * { title, class_name, requested_qty, issued_qty, reserved_qty, unit_price, line_total }
 */
function buildItemRows({ requested_summary = [], issued_summary = [], non_book_items = [] }) {
  const issuedMap = new Map(); // key => issued_qty
  for (const it of issued_summary || []) {
    const key = `${num(it.product_id)}:${num(it.book_id)}`;
    issuedMap.set(key, (issuedMap.get(key) || 0) + num(it.qty));
  }

  const rows = [];

  // BOOK rows from requested_summary
  for (const r of requested_summary || []) {
    const key = `${num(r.product_id)}:${num(r.book_id)}`;
    const requested = num(r.requested);
    const issued = issuedMap.get(key) || 0;
    const reserved = Math.max(0, requested - issued);

    const unit_price = num(r.rate);
    const line_total = requested * unit_price;

    rows.push({
      kind: "BOOK",
      product_id: num(r.product_id),
      book_id: num(r.book_id),
      title: r.title || "Book",
      class_name: r.class_name || r.class || r.std || null,
      requested_qty: requested,
      issued_qty: issued,
      reserved_qty: reserved,
      unit_price,
      line_total,
    });
  }

  // MATERIAL rows
  for (const n of non_book_items || []) {
    const requested = num(n.requested);
    const unit_price = num(n.rate);
    const line_total = requested * unit_price;

    rows.push({
      kind: "MATERIAL",
      product_id: num(n.product_id),
      book_id: 0,
      title: n.title || "Item",
      class_name: n.class_name || null,
      requested_qty: requested,
      issued_qty: requested, // treated as issued (no stock)
      reserved_qty: 0,
      unit_price,
      line_total,
    });
  }

  return rows;
}

/**
 * ✅ Compute status from meta
 */
function computeStatusFromMeta(meta) {
  const s = String(meta?.computed_status || "").toUpperCase();
  if (s) return s;

  // fallback older meta
  const totalIssuedNow = num(meta?.totalIssuedNow);
  const shortages = Array.isArray(meta?.shortages) ? meta.shortages : [];

  if (totalIssuedNow <= 0 && shortages.length) return "PENDING_STOCK";
  if (totalIssuedNow > 0 && shortages.length) return "PARTIAL";
  return "ISSUED";
}

/**
 * ✅ DB enum safe: only ISSUED/CANCELLED
 */
function statusForDB(computedStatus) {
  return String(computedStatus).toUpperCase() === "CANCELLED" ? "CANCELLED" : "ISSUED";
}

/**
 * ✅ Include builder (NO BundleItem.book_id anywhere)
 */
function issueInclude() {
  const inc = [];
  const A = BundleIssue?.associations || {};

  if (A.bundle) {
    inc.push({
      association: A.bundle,
      required: false,
      include: [
        Bundle?.associations?.school
          ? { association: Bundle.associations.school, required: false }
          : { model: School, required: false },

        Bundle?.associations?.items
          ? {
              association: Bundle.associations.items,
              required: false,
              include: [
                BundleItem?.associations?.product
                  ? {
                      association: BundleItem.associations.product,
                      required: false,
                      include: Product?.associations?.book
                        ? [{ association: Product.associations.book, required: false }]
                        : [],
                    }
                  : {
                      model: Product,
                      as: "product",
                      required: false,
                      include: Product?.associations?.book
                        ? [{ association: Product.associations.book, required: false }]
                        : [],
                    },
              ],
            }
          : {
              model: BundleItem,
              as: "items",
              required: false,
              include: [
                {
                  model: Product,
                  as: "product",
                  required: false,
                  include: Product?.associations?.book
                    ? [{ association: Product.associations.book, required: false }]
                    : [],
                },
              ],
            },
      ],
    });
  }

  if (A.issuedSchool) inc.push({ association: A.issuedSchool, required: false });
  if (A.issuedDistributor) inc.push({ association: A.issuedDistributor, required: false });

  return inc;
}

/**
 * ✅ Normalize issue json:
 * - notes: ALWAYS user-friendly (never __META__)
 * - pretty_notes: formatted meta summary
 * - meta: parsed meta json (with item_rows)
 * - status: computed status (PARTIAL/PENDING_STOCK/ISSUED/CANCELLED)
 */
function normalizeIssueRow(r) {
  const obj = r?.toJSON ? r.toJSON() : r;
  if (!obj) return obj;

  const { note, meta } = extractMetaFromRemarks(obj.remarks);

  obj.meta = meta || null;

  if (obj.meta) {
    // ensure item_rows exists for UI
    if (!Array.isArray(obj.meta.item_rows)) {
      obj.meta.item_rows = buildItemRows({
        requested_summary: obj.meta.requested_summary || [],
        issued_summary: obj.meta.issued_summary || [],
        non_book_items: obj.meta.non_book_items || [],
      });
    }

    // ensure totals exist for UI
    if (!obj.meta.totals) obj.meta.totals = {};
    obj.pretty_notes = formatMetaForHumans(obj.meta);

    // computed status
    obj.status =
      String(obj.status || "").toUpperCase() === "CANCELLED"
        ? "CANCELLED"
        : computeStatusFromMeta(obj.meta);

    // ✅ key fix: notes always user-friendly
    obj.notes = note ?? obj.pretty_notes ?? null;
  } else {
    obj.pretty_notes = null;
    obj.notes = note ?? null;
    // if no meta, fall back to DB status
    obj.status = String(obj.status || "ISSUED").toUpperCase();
  }

  obj.bundle_notes = obj.bundle?.notes ?? null;
  return obj;
}

/* ---------------- PDF helpers ---------------- */

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

  const parts = [
    name,
    addr ? addr : null,
    gst ? `GSTIN: ${gst}` : null,
    phone ? `Ph: ${phone}` : null,
    email ? `Email: ${email}` : null,
  ].filter(Boolean);

  return parts;
}

function drawHr(doc, y) {
  doc.moveTo(40, y).lineTo(555, y).lineWidth(1).strokeColor("#ddd").stroke();
  doc.strokeColor("#000");
}

/**
 * Generates invoice PDF buffer for a BundleIssue (school/distributor).
 * ✅ Logo (URL/local/base64) + local fallback assets/logo.png
 * ✅ Invoice To is ALWAYS the Bundle's School (not the distributor)
 * ✅ Currency format: "Rs. 123.00" (NO ₹ symbol)
 * ✅ Class-wise sections with borders + headings
 * ✅ Table with borders (Item + Sale Price)
 *
 * ✅ FIX: If meta.item_rows has 0 price, we fallback to BundleItem.sale_price/mrp/product rates.
 */
async function generateIssueInvoicePdf({ issueRow, bundleRow, billedToRow, companyRow }) {
  const doc = new PDFDocument({ size: "A4", margin: 40 });

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
    if (!s) return null;

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

    // local file (absolute or relative to project root)
    try {
      const localPath = path.isAbsolute(s) ? s : path.join(process.cwd(), s);
      if (fs.existsSync(localPath)) {
        return fs.readFileSync(localPath);
      }
    } catch {
      return null;
    }

    return null;
  }

  /* ---------------- Helpers ---------------- */

  const leftX = 40;
  const rightX = 340;
  const pageRight = 555; // approx A4 with margin 40
  const contentWidth = pageRight - leftX;

  const money = (v) => round2(num(v)).toFixed(2);
  const fmtRs = (v) => `Rs. ${money(v)}`;

  const ensurePageSpace = (minSpace = 60) => {
    const bottom = 800; // safe footer zone
    if (doc.y + minSpace > bottom) {
      doc.addPage();
      doc.y = 40;
    }
  };

  const drawBox = (x, y, w, h, opts = {}) => {
    const lw = opts.lineWidth ?? 1;
    const color = opts.color ?? "#111";
    doc.save();
    doc.lineWidth(lw).strokeColor(color).rect(x, y, w, h).stroke();
    doc.restore();
  };

  const drawFill = (x, y, w, h, fill = "#f3f4f6") => {
    doc.save();
    doc.fillColor(fill).rect(x, y, w, h).fill();
    doc.restore();
  };

  const drawText = (text, x, y, w, align = "left", size = 9, bold = false) => {
    doc.fontSize(size);
    doc.font(bold ? "Helvetica-Bold" : "Helvetica");
    doc.text(String(text ?? ""), x, y, { width: w, align });
  };

  // ---------------- Header ----------------

  // ✅ robust logo loading (companyRow first, then local fallback)
  const logoRef =
    companyRow?.logo_url ||
    companyRow?.logo ||
    companyRow?.logo_path ||
    companyRow?.logo_image ||
    companyRow?.logoRef ||
    null;

  const FALLBACK_LOGO_PATHS = [
    // put your logo in /assets/logo.png (project root)
    path.join(process.cwd(), "assets/logo.png"),
    path.join(process.cwd(), "src/assets/logo.png"),
    // if you keep it in backend/src/assets/logo.png:
    path.join(process.cwd(), "backend/src/assets/logo.png"),
  ];

  let logoBuf = null;

  // try companyRow refs (url/local/base64)
  try {
    logoBuf = await loadLogoBuffer(logoRef);
  } catch {
    logoBuf = null;
  }

  // fallback to local known paths
  if (!logoBuf) {
    for (const pth of FALLBACK_LOGO_PATHS) {
      try {
        if (fs.existsSync(pth)) {
          logoBuf = fs.readFileSync(pth);
          break;
        }
      } catch {}
    }
  }

  // draw logo if available
  const logoY = 35;
  const logoW = 75;

  if (logoBuf) {
    try {
      doc.image(logoBuf, leftX, logoY, { width: logoW });
    } catch {
      // If image fails to render (bad PNG/JPG), ignore gracefully
    }
  }

  // Company
  const companyLines = getCompanyLine(companyRow);
  const companyX = logoBuf ? leftX + logoW + 15 : leftX;

  doc.font("Helvetica-Bold").fontSize(16).text(companyLines[0] || "Company", companyX, 40, {
    align: "left",
  });
  doc.font("Helvetica").fontSize(9);
  for (let i = 1; i < companyLines.length; i++) doc.text(companyLines[i], companyX, doc.y);

  // Invoice title
  doc.font("Helvetica-Bold").fontSize(16).text("INVOICE", 0, 40, { align: "right" });

// ✅ keep the header separator below logo/company block
const logoBottomY = 35 + 52; // if your logo height ~52 (75 width keeps aspect; safe)
const safeTextBottomY = doc.y; // after company lines have been written
const headerBottomY = Math.max(logoBottomY, safeTextBottomY) + 10;

drawHr(doc, headerBottomY);
doc.y = headerBottomY + 12;


  // Invoice meta (right)
  const invNo = safeText(issueRow?.issue_no || issueRow?.id || "");
  const invDate = formatDateIN(issueRow?.issue_date);
  const bundleId = num(issueRow?.bundle_id || bundleRow?.id || 0) || "-";
  const session = safeText(bundleRow?.academic_session || "");
  const status = safeText(
    String(issueRow?.status || "").toUpperCase() === "CANCELLED"
      ? "CANCELLED"
      : safeText(issueRow?.status || "")
  );

  const startY = doc.y;

  doc.font("Helvetica").fontSize(10);
  doc.text(`Invoice No: ${invNo}`, rightX, startY, { align: "left" });
  doc.text(`Date: ${invDate}`, rightX, doc.y, { align: "left" });
  doc.text(`Bundle: #${bundleId}`, rightX, doc.y, { align: "left" });
  if (session) doc.text(`Session: ${session}`, rightX, doc.y, { align: "left" });
  if (status) doc.text(`Status: ${status}`, rightX, doc.y, { align: "left" });

  // ✅ Invoice To: ALWAYS bundle school
  const schoolRow = bundleRow?.school || billedToRow || null;

  const schoolName = safeText(
    schoolRow?.name ||
      schoolRow?.school_name ||
      schoolRow?.title ||
      (bundleRow?.school_id ? `School #${bundleRow.school_id}` : "")
  );
  const schoolAddr = safeText(schoolRow?.address || schoolRow?.city || "");
  const schoolPhone = safeText(schoolRow?.phone || schoolRow?.mobile || "");
  const schoolEmail = safeText(schoolRow?.email || "");

  doc.font("Helvetica-Bold").fontSize(11).text("Invoice To (School):", leftX, startY);
  doc.font("Helvetica").fontSize(10).text(schoolName || "-", leftX, doc.y);
  if (schoolAddr) doc.text(schoolAddr, leftX, doc.y);
  if (schoolPhone) doc.text(`Ph: ${schoolPhone}`, leftX, doc.y);
  if (schoolEmail) doc.text(`Email: ${schoolEmail}`, leftX, doc.y);

  // Space before items
  doc.y = Math.max(doc.y, startY + 75);
  drawHr(doc, doc.y);
  doc.y += 10;

  // ---------------- Items build ----------------
  const normalized = normalizeIssueRow(issueRow);
  const meta = normalized?.meta || null;

  let rows = [];
  if (meta?.item_rows && Array.isArray(meta.item_rows)) {
    rows = meta.item_rows;
  } else {
    // fallback: build from bundle items as "requested"
    const requested_summary = [];
    const issued_summary = [];
    const non_book_items = [];

    for (const bi of bundleRow?.items || []) {
      const p = bi.product || null;
      const product_type = normalizeProductType(p);
      const book_id = resolveBookIdFromProduct(p);
      const rate = resolveRateFromItemProduct(bi, p);
      const title =
        p?.book?.title || p?.name || p?.title || (product_type === "BOOK" ? "Book" : "Item");
      const class_name = p?.book?.class_name || p?.class_name || null;

      const requested = Math.max(0, num(bi.qty));
      if (product_type === "BOOK") {
        requested_summary.push({
          product_id: num(bi.product_id),
          book_id: num(book_id),
          title,
          class_name,
          requested,
          rate,
        });
      } else {
        non_book_items.push({
          product_id: num(bi.product_id),
          title,
          class_name,
          requested,
          type: product_type,
          rate,
        });
      }
    }

    rows = buildItemRows({ requested_summary, issued_summary, non_book_items });
  }

  /**
   * ✅ PRICE FALLBACK MAP (Fix for "0 price" in meta.item_rows)
   * Key priority:
   * 1) product_id + book_id
   * 2) product_id
   * 3) title (lowercase)
   */
  const priceMap = new Map();

  for (const bi of bundleRow?.items || []) {
    const p = bi.product || null;

    const pId = num(bi.product_id || p?.id);
    const bId = num(resolveBookIdFromProduct(p));

    const title =
      safeText(p?.book?.title) ||
      safeText(p?.name) ||
      safeText(p?.title) ||
      (normalizeProductType(p) === "BOOK" ? "Book" : "Item");

    const rate = resolveRateFromItemProduct(bi, p);

    if (pId && bId) priceMap.set(`pb:${pId}:${bId}`, rate);
    if (pId) priceMap.set(`p:${pId}`, rate);
    if (title) priceMap.set(`t:${title.toLowerCase()}`, rate);
  }

  // Only Item + Sale Price, grouped by class_name
  const pdfRows = (rows || []).map((r) => {
    const title = safeText(r.title || r.book_title || r.product_name || "Item");
    const class_name = safeText(r.class_name || "Unassigned") || "Unassigned";

    const pId = num(r.product_id);
    const bId = num(r.book_id);

    // ✅ Price with strong fallbacks
    let price =
      num(r.unit_price) ||
      num(r.rate) ||
      num(r.selling_price) ||
      num(r.sale_price) ||
      num(r.mrp) ||
      0;

    if (!price) {
      price =
        (pId && bId ? num(priceMap.get(`pb:${pId}:${bId}`)) : 0) ||
        (pId ? num(priceMap.get(`p:${pId}`)) : 0) ||
        (title ? num(priceMap.get(`t:${title.toLowerCase()}`)) : 0) ||
        0;
    }

    return { class_name, title, price };
  });

  // Group by class
  const groupMap = new Map();
  for (const r of pdfRows) {
    const key = r.class_name || "Unassigned";
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(r);
  }
  const classKeys = Array.from(groupMap.keys()).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );

  // Columns for class-wise table
  const tableX = leftX;
  const tableW = contentWidth;
  const colItemW = Math.floor(tableW * 0.72);
  const colPriceW = tableW - colItemW;

  let computedTotal = 0;

  for (const className of classKeys) {
    const items = (groupMap.get(className) || []).slice().sort((a, b) =>
      a.title.localeCompare(b.title)
    );

    ensurePageSpace(90);

    // Section heading
    const headingY = doc.y;
    const headingH = 26;

    drawFill(tableX, headingY, tableW, headingH, "#f3f4f6");
    drawBox(tableX, headingY, tableW, headingH, { color: "#111", lineWidth: 1 });
    drawText(
      `${className} — Items & Sale Price`,
      tableX + 10,
      headingY + 7,
      tableW - 20,
      "left",
      10,
      true
    );

    doc.y = headingY + headingH;

    // Table header
    ensurePageSpace(60);
    const headerY = doc.y;
    const headerH = 22;

    drawFill(tableX, headerY, tableW, headerH, "#fafafa");
    drawBox(tableX, headerY, tableW, headerH, { color: "#111", lineWidth: 1 });

    // vertical separator
    doc
      .save()
      .lineWidth(1)
      .strokeColor("#111")
      .moveTo(tableX + colItemW, headerY)
      .lineTo(tableX + colItemW, headerY + headerH)
      .stroke()
      .restore();

    drawText("Item", tableX + 10, headerY + 6, colItemW - 20, "left", 9, true);
    drawText("Sale Price", tableX + colItemW + 10, headerY + 6, colPriceW - 20, "right", 9, true);

    doc.y = headerY + headerH;

    // Rows
    for (const it of items) {
      ensurePageSpace(40);

      const rowY = doc.y;
      const rowH = 20;

      drawBox(tableX, rowY, tableW, rowH, { color: "#111", lineWidth: 1 });

      doc
        .save()
        .lineWidth(1)
        .strokeColor("#111")
        .moveTo(tableX + colItemW, rowY)
        .lineTo(tableX + colItemW, rowY + rowH)
        .stroke()
        .restore();

      drawText(it.title, tableX + 10, rowY + 5, colItemW - 20, "left", 9, false);
      drawText(fmtRs(it.price), tableX + colItemW + 10, rowY + 5, colPriceW - 20, "right", 9, true);

      computedTotal += num(it.price);

      doc.y = rowY + rowH;
    }

    doc.y += 10;
  }

  // ✅ Totals (prefer meta total if exists, else computed)
  ensurePageSpace(80);

  const metaTotal = num(meta?.totals?.total_amount);
  const totalToShow = metaTotal > 0 ? metaTotal : computedTotal;

  const totalY = doc.y;
  const totalH = 26;

  drawFill(tableX, totalY, tableW, totalH, "#f3f4f6");
  drawBox(tableX, totalY, tableW, totalH, { color: "#111", lineWidth: 1 });

  drawText("Grand Total", tableX + 10, totalY + 7, colItemW - 20, "left", 10, true);
  drawText(fmtRs(totalToShow), tableX + colItemW + 10, totalY + 7, colPriceW - 20, "right", 10, true);

  doc.y = totalY + totalH + 12;

  // Notes
  const notes = safeText(normalized?.notes || "");
  if (notes) {
    ensurePageSpace(80);
    doc.font("Helvetica-Bold").fontSize(10).text("Notes:", leftX, doc.y);
    doc.font("Helvetica").fontSize(9).text(notes, leftX, doc.y + 12, { width: 515 });
    doc.y += 40;
  }

  // Footer
  doc.font("Helvetica").fontSize(8).text("This is a computer generated invoice.", 40, 800, {
    align: "center",
  });

  return collectPdfBuffer(doc);
}





/* =========================================================
   ✅ POST /api/bundle-issues
   body: { bundle_id, issued_to_type, issued_to_id, qty, notes }
   ========================================================= */
exports.create = async (request, reply) => {
  const body = request.body || {};
  const bundle_id = num(body.bundle_id);
  if (!bundle_id) return reply.code(400).send({ message: "bundle_id is required" });

  request.params = request.params || {};
  request.params.id = String(bundle_id);

  request.body = request.body || {};
  request.body.remarks = request.body.remarks ?? request.body.notes ?? null;
  request.body.qty = Math.max(1, num(request.body.qty) || 1);

  return exports.issueBundle(request, reply);
};

/* =========================================================
   POST /api/bundle-issues/bundles/:id/issue
   ✅ Deduct inventory ONLY for BOOK items
   ✅ MATERIAL allowed without book_id and skipped
   ✅ Partial issue allowed (computed status in meta)
   ✅ UI details payload includes meta.item_rows with price info
   ========================================================= */
exports.issueBundle = async (request, reply) => {
  const bundleId = num(request.params?.id);
  const body = request.body || {};

  const issue_date = (body.issue_date && String(body.issue_date).trim()) || null;
  const issued_to_type_raw = String(body.issued_to_type || "SCHOOL").toUpperCase();
  const issued_to_id_raw = num(body.issued_to_id);
  const qtyMultiplier = Math.max(1, num(body.qty) || 1);

  const remarksRaw = body.remarks ?? body.notes;
  const remarks = remarksRaw ? String(remarksRaw).trim() : null;

  const sessionFromBody = body.academic_session ? String(body.academic_session).trim() : null;

  if (!bundleId) return reply.code(400).send({ message: "Invalid bundle id" });
  if (!["SCHOOL", "DISTRIBUTOR"].includes(issued_to_type_raw)) {
    return reply.code(400).send({ message: "issued_to_type must be SCHOOL or DISTRIBUTOR" });
  }
  if (!issued_to_id_raw) return reply.code(400).send({ message: "issued_to_id is required" });

  const t = await sequelize.transaction();
  try {
    let issued_to_type = issued_to_type_raw;
    let issued_to_id = issued_to_id_raw;

    try {
      const enforced = enforceIssuerAuthorization({
        user: request.user,
        issued_to_type,
        issued_to_id,
      });
      issued_to_type = enforced.issued_to_type;
      issued_to_id = enforced.issued_to_id;
    } catch (e) {
      const code = e.statusCode || 403;
      await t.rollback();
      return reply.code(code).send({ message: e.message });
    }

    // ✅ Load bundle + items + product (+ optional book)
    const bundle = await Bundle.findByPk(bundleId, {
      include: [
        {
          model: BundleItem,
          as: "items",
          required: false,
          include: [
            {
              model: Product,
              as: "product",
              required: false,
              include: Product?.associations?.book
                ? [{ association: Product.associations.book, required: false }]
                : [],
            },
          ],
        },
        { model: School, as: "school", required: false },
      ],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!bundle) {
      await t.rollback();
      return reply.code(404).send({ message: "Bundle not found" });
    }

    // Optional: session check if provided
    if (sessionFromBody && String(bundle.academic_session || "").trim() !== sessionFromBody) {
      await t.rollback();
      return reply.code(400).send({
        message: `Academic session mismatch. Bundle is ${bundle.academic_session}`,
      });
    }

    const st = String(bundle.status || "").toUpperCase();
    if (["ISSUED", "DISPATCHED", "DELIVERED"].includes(st)) {
      await t.rollback();
      return reply.code(400).send({ message: `Bundle already ${bundle.status}` });
    }
    if (st === "CANCELLED") {
      await t.rollback();
      return reply.code(400).send({ message: "Cannot issue a CANCELLED bundle" });
    }

    // verify issued_to exists
    if (issued_to_type === "SCHOOL") {
      const s = await School.findByPk(issued_to_id, { transaction: t });
      if (!s) {
        await t.rollback();
        return reply.code(404).send({ message: "Target school not found" });
      }
    } else {
      const d = await Distributor.findByPk(issued_to_id, { transaction: t });
      if (!d) {
        await t.rollback();
        return reply.code(404).send({ message: "Target distributor not found" });
      }
    }

    // ✅ Build issue items
    const rawItems = (bundle.items || []).map((it) => {
      const p = it.product || null;
      const product_type = normalizeProductType(p);
      const book_id = resolveBookIdFromProduct(p);
      const rate = resolveRateFromItemProduct(it, p);

      const title =
        p?.book?.title ||
        p?.name ||
        p?.title ||
        (product_type === "BOOK" ? "Book" : "Item");

      const class_name =
        p?.book?.class_name ||
        p?.class_name ||
        p?.book?.class ||
        p?.book?.std ||
        null;

      return {
        id: it.id,
        product_id: num(it.product_id),
        qty: Math.max(0, num(it.qty)),
        toRequest: Math.max(0, num(it.qty)) * qtyMultiplier,
        product_type,
        book_id,
        rate,
        title,
        class_name,
      };
    });

    const issueItems = rawItems.filter((x) => x.toRequest > 0);

    if (!issueItems.length) {
      await t.rollback();
      return reply.code(400).send({ message: "Nothing to issue (qty is 0 in bundle items)." });
    }

    // ✅ ONLY BOOK items require book_id
    const unmappedBooks = issueItems.filter((x) => x.product_type === "BOOK" && !x.book_id);
    if (unmappedBooks.length) {
      await t.rollback();
      return reply.code(400).send({
        message:
          "Some BOOK bundle items are not linked to a book (cannot deduct inventory). Fix Product.book_id mapping.",
        items: unmappedBooks.map((x) => ({
          bundle_item_id: x.id,
          product_id: x.product_id,
          product_name: x.title,
        })),
      });
    }

    const bookIssueItems = issueItems.filter((x) => x.product_type === "BOOK");

    const shortages = [];
    const allocationsPerItem = new Map();
    const requested_summary = [];
    const issued_summary = [];

    let totalRequested = 0;
    let totalIssuedNow = 0;

    let requested_amount_total = 0;
    let issued_amount_total = 0;
    let reserved_amount_total = 0;

    for (const it of bookIssueItems) {
      const { allocations, remaining } = await allocateFromBatches({
        book_id: it.book_id,
        qtyNeeded: it.toRequest,
        t,
        lock: true,
      });

      const issuedNow = allocations.reduce((s, a) => s + num(a.qty), 0);
      const reservedNow = Math.max(0, num(it.toRequest) - num(issuedNow));

      totalRequested += num(it.toRequest);
      totalIssuedNow += num(issuedNow);

      const reqAmt = num(it.toRequest) * num(it.rate);
      const issAmt = num(issuedNow) * num(it.rate);
      const resAmt = num(reservedNow) * num(it.rate);

      requested_amount_total += reqAmt;
      issued_amount_total += issAmt;
      reserved_amount_total += resAmt;

      requested_summary.push({
        bundle_item_id: it.id,
        product_id: it.product_id,
        book_id: it.book_id,
        title: it.title,
        class_name: it.class_name,
        requested: it.toRequest,
        rate: it.rate,
        amount: reqAmt,
      });

      if (issuedNow > 0) {
        allocationsPerItem.set(it.id, allocations);
        issued_summary.push({
          bundle_item_id: it.id,
          product_id: it.product_id,
          book_id: it.book_id,
          title: it.title,
          class_name: it.class_name,
          qty: issuedNow,
          rate: it.rate,
          amount: issAmt,
        });
      }

      if (remaining > 0) {
        shortages.push({
          book_id: it.book_id,
          title: it.title,
          requested: it.toRequest,
          shortBy: remaining,
        });
      }
    }

    // MATERIAL items are treated as issued (no inventory)
    const non_book_items = issueItems
      .filter((x) => x.product_type !== "BOOK")
      .map((x) => {
        const reqAmt = num(x.toRequest) * num(x.rate);
        requested_amount_total += reqAmt;
        issued_amount_total += reqAmt; // counted as issued
        return {
          bundle_item_id: x.id,
          product_id: x.product_id,
          title: x.title,
          class_name: x.class_name,
          requested: x.toRequest,
          type: x.product_type,
          rate: x.rate,
          amount: reqAmt,
        };
      });

    // ✅ computed status (for UI)
    const computed_status =
      bookIssueItems.length === 0
        ? "ISSUED"
        : totalIssuedNow <= 0
        ? "PENDING_STOCK"
        : shortages.length > 0
        ? "PARTIAL"
        : "ISSUED";

    // ✅ DB enum safe status
    const status_db = statusForDB(computed_status);

    // unique issue_no
    let issue_no = makeIssueNo();
    for (let i = 0; i < 5; i++) {
      const exists = await BundleIssue.findOne({ where: { issue_no }, transaction: t });
      if (!exists) break;
      issue_no = makeIssueNo();
    }

    const meta = {
      mode: "PARTIAL_ALLOWED",
      computed_status,
      qty_multiplier: qtyMultiplier,
      totalRequested,
      totalIssuedNow,
      shortages,
      issued_summary,
      requested_summary,
      non_book_items,
    };

    // UI table rows
    meta.item_rows = buildItemRows({
      requested_summary: meta.requested_summary,
      issued_summary: meta.issued_summary,
      non_book_items: meta.non_book_items,
    });

    meta.totals = {
      requested_amount: requested_amount_total,
      issued_amount: issued_amount_total,
      reserved_amount: reserved_amount_total,
      total_amount: requested_amount_total,
    };

    // ✅ Keep remarks human + attach meta
    const mergedRemarks = (() => {
      const base = remarks ? String(remarks) : "";
      const json = JSON.stringify(meta);
      return base ? `${base}\n\n__META__=${json}` : `__META__=${json}`;
    })();

    const issue = await BundleIssue.create(
      {
        bundle_id: bundle.id,
        issue_no,
        issue_date: issue_date || new Date().toISOString().slice(0, 10),
        issued_to_type,
        issued_to_id,
        issued_by: request.user?.id || null,
        remarks: mergedRemarks,
        status: status_db, // ✅ ISSUED only (unless cancelled)
      },
      { transaction: t }
    );

    // ✅ Deduct inventory for BOOK only
    const outTxns = [];

    for (const it of bookIssueItems) {
      const allocs = allocationsPerItem.get(it.id) || [];
      if (!allocs.length) continue;

      for (const a of allocs) {
        outTxns.push({
          txn_type: TXN_TYPE.OUT,
          book_id: it.book_id,
          batch_id: a.batch_id,
          qty: a.qty,
          ref_type: "BUNDLE_ISSUE",
          ref_id: issue.id,
          notes: `Issue bundle #${bundle.id} (x${qtyMultiplier}) via issue #${issue.issue_no} to ${issued_to_type}:${issued_to_id}`,
        });
      }

      for (const a of allocs) {
        await InventoryBatch.update(
          { available_qty: sequelize.literal(`available_qty - ${a.qty}`) },
          { where: { id: a.batch_id }, transaction: t }
        );
      }
    }

    if (outTxns.length) {
      await InventoryTxn.bulkCreate(outTxns, { transaction: t });
    }

    // ✅ Bundle status
    const newBundleStatus =
      computed_status === "ISSUED"
        ? "ISSUED"
        : computed_status === "PENDING_STOCK"
        ? "RESERVED"
        : "PARTIAL";

    await bundle.update({ status: newBundleStatus }, { transaction: t });

    await t.commit();

    // ✅ response normalized for UI
    const normalized = normalizeIssueRow(issue);

    return reply.send({
      message:
        computed_status === "ISSUED"
          ? "Bundle issued successfully"
          : computed_status === "PARTIAL"
          ? "Bundle issued partially (pending stock)"
          : "Issue created (pending stock). No inventory deducted.",
      issue: {
        id: issue.id,
        issue_no: issue.issue_no,
        issue_date: issue.issue_date,
        issued_to_type: issue.issued_to_type,
        issued_to_id: issue.issued_to_id,
        status: normalized.status,
        notes: normalized.notes,
        pretty_notes: normalized.pretty_notes,
        meta: normalized.meta,
        remarks: issue.remarks ?? null,
      },
      bundle: {
        id: bundle.id,
        status: newBundleStatus,
        notes: bundle.notes ?? null,
      },
    });
  } catch (err) {
    request.log.error({ err }, "issueBundle failed");
    await t.rollback();
    return reply.code(500).send({ message: err?.message || "Internal Server Error" });
  }
};

/* =========================================================
   ✅ GET /api/bundle-issues/:id/invoice
   - Generates Invoice PDF for a BundleIssue
   - Works for SCHOOL and DISTRIBUTOR
   - Distributor users can download only their own issues
   ========================================================= */
exports.invoicePdf = async (request, reply) => {
  const issueId = num(request.params?.id);
  if (!issueId) return reply.code(400).send({ message: "Invalid issue id" });

  try {
    const issue = await BundleIssue.findByPk(issueId, {
      include: issueInclude(),
    });

    if (!issue) return reply.code(404).send({ message: "Issue not found" });

    // ✅ Distributor users can view only their own issues
    if (!isAdminish(request.user) && isDistributorUser(request.user)) {
      const myDid = getDistributorIdFromUser(request.user);
      if (!myDid) return reply.code(403).send({ message: "Distributor not linked" });

      if (
        String(issue.issued_to_type).toUpperCase() !== "DISTRIBUTOR" ||
        Number(issue.issued_to_id) !== Number(myDid)
      ) {
        return reply.code(403).send({ message: "Not allowed to view this invoice" });
      }
    }

    const bundle = issue.bundle || (await Bundle.findByPk(issue.bundle_id, { include: [] }));
    if (!bundle) return reply.code(404).send({ message: "Bundle not found for this issue" });

    // Load billed-to
    let billedTo = null;
    if (String(issue.issued_to_type).toUpperCase() === "SCHOOL") {
      billedTo =
        issue.issuedSchool ||
        (await School.findByPk(issue.issued_to_id).catch(() => null));
    } else {
      billedTo =
        issue.issuedDistributor ||
        (await Distributor.findByPk(issue.issued_to_id).catch(() => null));
    }

    // Company profile (optional)
    let companyRow = null;
    if (CompanyProfile && CompanyProfile.findOne) {
      companyRow = await CompanyProfile.findOne({ order: [["id", "DESC"]] }).catch(() => null);
    }

    const pdfBuffer = await generateIssueInvoicePdf({
      issueRow: issue,
      bundleRow: bundle,
      billedToRow: billedTo,
      companyRow,
    });

    const fileName = `invoice_${safeText(issue.issue_no || issue.id)}.pdf`;

    reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `inline; filename="${fileName}"`);

    return reply.send(pdfBuffer);
  } catch (err) {
    request.log.error({ err }, "invoicePdf failed");
    return reply.code(500).send({ message: err?.message || "Internal Server Error" });
  }
};

/* =========================================================
   GET /api/bundle-issues/bundles/:id/issues
   ========================================================= */
exports.listIssuesForBundle = async (request, reply) => {
  const bundleId = num(request.params?.id);
  if (!bundleId) return reply.code(400).send({ message: "Invalid bundle id" });

  try {
    const rows = await BundleIssue.findAll({
      where: { bundle_id: bundleId },
      include: issueInclude(),
      order: [["id", "DESC"]],
    });

    const out = rows.map(normalizeIssueRow);
    return reply.send({ rows: out });
  } catch (err) {
    request.log.error({ err }, "listIssuesForBundle failed");
    return reply.code(500).send({ message: err?.message || "Internal Server Error" });
  }
};

/* =========================================================
   GET /api/bundle-issues
   Query:
     ?academic_session=2026-27
     ?limit=200
     ?status=ISSUED|CANCELLED|PARTIAL|PENDING_STOCK
   NOTE: DB stores only ISSUED/CANCELLED, so we filter computed status in JS.
   ========================================================= */
exports.list = async (request, reply) => {
  try {
    const academic_session = request.query?.academic_session
      ? String(request.query.academic_session).trim()
      : null;

    const statusWanted = request.query?.status
      ? String(request.query.status).trim().toUpperCase()
      : null;

    const limit = Math.min(500, Math.max(1, num(request.query?.limit) || 200));

    const where = {};

    // ✅ Distributor users only see their own issues
    if (!isAdminish(request.user) && isDistributorUser(request.user)) {
      const myDid = getDistributorIdFromUser(request.user);
      if (!myDid) return reply.code(403).send({ message: "Distributor not linked" });

      where.issued_to_type = "DISTRIBUTOR";
      where.issued_to_id = myDid;
    }

    // DB status filter only for CANCELLED (since others are stored as ISSUED)
    if (statusWanted === "CANCELLED") where.status = "CANCELLED";

    const rows = await BundleIssue.findAll({
      where,
      include: issueInclude(),
      order: [["id", "DESC"]],
      limit,
    });

    // normalize (adds computed status + item_rows)
    let out = rows.map(normalizeIssueRow);

    // session filter
    if (academic_session) {
      out = out.filter((r) => {
        const s = r.bundle?.academic_session ? String(r.bundle.academic_session).trim() : "";
        return s === academic_session;
      });
    }

    // computed status filter (PARTIAL/PENDING_STOCK/ISSUED)
    if (statusWanted && statusWanted !== "CANCELLED") {
      out = out.filter((r) => String(r.status || "").toUpperCase() === statusWanted);
    }

    return reply.send({ rows: out });
  } catch (err) {
    request.log.error({ err }, "bundleIssue list failed");
    return reply.code(500).send({ message: err?.message || "Internal Server Error" });
  }
};

/* =========================================================
   POST /api/bundle-issues/:id/cancel
   ✅ Revert inventory back to batches (IN txns)
   ✅ Mark issue as CANCELLED
   ========================================================= */
exports.cancel = async (request, reply) => {
  const issueId = num(request.params?.id);
  if (!issueId) return reply.code(400).send({ message: "Invalid issue id" });

  const t = await sequelize.transaction();
  try {
    const issue = await BundleIssue.findByPk(issueId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!issue) {
      await t.rollback();
      return reply.code(404).send({ message: "Issue not found" });
    }

    const issueStatusDb = String(issue.status || "ISSUED").toUpperCase();
    if (issueStatusDb === "CANCELLED") {
      await t.rollback();
      return reply.code(400).send({ message: "Issue already CANCELLED" });
    }

    // ✅ Distributor users can cancel only their own issues
    if (!isAdminish(request.user) && isDistributorUser(request.user)) {
      const myDid = getDistributorIdFromUser(request.user);
      if (!myDid) {
        await t.rollback();
        return reply.code(403).send({ message: "Distributor not linked" });
      }
      if (
        String(issue.issued_to_type).toUpperCase() !== "DISTRIBUTOR" ||
        Number(issue.issued_to_id) !== Number(myDid)
      ) {
        await t.rollback();
        return reply.code(403).send({ message: "Not allowed to cancel this issue" });
      }
    }

    // load bundle
    const bundle = await Bundle.findByPk(issue.bundle_id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!bundle) {
      await t.rollback();
      return reply.code(404).send({ message: "Bundle not found for this issue" });
    }

    // find OUT txns for this issue
    const outTxns = await InventoryTxn.findAll({
      where: {
        ref_type: "BUNDLE_ISSUE",
        ref_id: issue.id,
        txn_type: TXN_TYPE.OUT,
      },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    const byBatch = new Map();
    if (outTxns.length) {
      for (const tx of outTxns) {
        const bId = num(tx.batch_id);
        const q = num(tx.qty);
        if (bId) byBatch.set(bId, (byBatch.get(bId) || 0) + q);
      }

      // add back to batches
      for (const [batch_id, qtyAdd] of byBatch.entries()) {
        await InventoryBatch.update(
          { available_qty: sequelize.literal(`available_qty + ${qtyAdd}`) },
          { where: { id: batch_id }, transaction: t }
        );
      }

      // create IN txns
      const inTxns = [];
      for (const [batch_id, qtyAdd] of byBatch.entries()) {
        const any = outTxns.find((x) => num(x.batch_id) === num(batch_id));
        inTxns.push({
          txn_type: TXN_TYPE.IN,
          book_id: num(any?.book_id),
          batch_id: num(batch_id),
          qty: qtyAdd,
          ref_type: "BUNDLE_ISSUE_CANCEL",
          ref_id: issue.id,
          notes: `Cancel issue #${issue.issue_no || issue.id} -> stock revert for bundle #${
            bundle.id
          }`,
        });
      }
      await InventoryTxn.bulkCreate(inTxns, { transaction: t });
    }

    // mark cancelled (DB enum supports this)
    await issue.update(
      {
        status: "CANCELLED",
        cancelled_at: new Date(),
        cancelled_by: request.user?.id || null,
      },
      { transaction: t }
    );

    // recalc bundle status from remaining non-cancelled issues
    const remainingIssues = await BundleIssue.findAll({
      where: { bundle_id: bundle.id, status: { [Op.ne]: "CANCELLED" } },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    let newStatus = "RESERVED";
    if (remainingIssues.length) {
      // remaining issues are all stored as ISSUED in DB; check meta for partial
      const normalizedRemaining = remainingIssues.map(normalizeIssueRow);
      const sts = normalizedRemaining.map((x) => String(x.status || "").toUpperCase());
      if (sts.includes("ISSUED")) newStatus = "ISSUED";
      else if (sts.includes("PARTIAL") || sts.includes("PENDING_STOCK")) newStatus = "PARTIAL";
      else newStatus = "RESERVED";
    }

    await bundle.update({ status: newStatus }, { transaction: t });

    await t.commit();

    const normalized = normalizeIssueRow(issue);

    return reply.send({
      message: outTxns.length
        ? "Issue cancelled successfully (stock reverted)"
        : "Issue cancelled successfully (no stock was deducted)",
      issue: {
        id: issue.id,
        issue_no: issue.issue_no,
        status: "CANCELLED",
        notes: normalized.notes,
        pretty_notes: normalized.pretty_notes,
        meta: normalized.meta,
        remarks: issue.remarks ?? null,
      },
      bundle: {
        id: bundle.id,
        status: newStatus,
        notes: bundle.notes ?? null,
      },
      reverted: {
        batches: Array.from(byBatch.entries()).map(([batch_id, qty]) => ({ batch_id, qty })),
      },
    });
  } catch (err) {
    request.log.error({ err }, "cancel issue failed");
    await t.rollback();
    return reply.code(500).send({ message: err?.message || "Internal Server Error" });
  }
};
