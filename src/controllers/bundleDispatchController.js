// src/controllers/bundleDispatchController.js
"use strict";

const { Op } = require("sequelize");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const {
  Bundle,
  BundleItem,
  BundleIssue,
  BundleDispatch,
  School,
  Distributor,
  Book,
  CompanyProfile,
  Transport,
  sequelize,
} = require("../models");

/* ---------------- Helpers ---------------- */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const cleanStr = (v) => (v === null || v === undefined ? null : String(v).trim() || null);
const todayISO = () => new Date().toISOString().slice(0, 10);

// Create DC number like: DC-2025-12-000123
function makeChallanNo(seq) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const s = String(seq).padStart(6, "0");
  return `DC-${y}-${m}-${s}`;
}

// Generates a unique challan_no using MAX(id)+1 style (safe enough, with collision checks)
async function generateUniqueChallanNo({ t }) {
  const maxId = (await BundleDispatch.max("id", { transaction: t })) || 0;
  let seq = maxId + 1;

  for (let i = 0; i < 20; i++) {
    const candidate = makeChallanNo(seq);
    const exists = await BundleDispatch.findOne({ where: { challan_no: candidate }, transaction: t });
    if (!exists) return candidate;
    seq++;
  }

  const ts = Date.now().toString().slice(-8);
  return `DC-${ts}`;
}

/**
 * Build PDF Buffer safely (Fastify-friendly)
 */
function buildPdfBuffer(buildFn) {
  return new Promise((resolve, reject) => {
    // ✅ reduce margins for less blank space
    const doc = new PDFDocument({ size: "A4", margin: 24 });
    const chunks = [];

    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    buildFn(doc);
    doc.end();
  });
}

/**
 * Resolve local logo file path from company.logo_url.
 * Supports:
 * - "/uploads/.."
 * - "uploads/.."
 * - "/public/uploads/.."
 * - absolute local path
 *
 * NOTE: PDFKit works best with PNG/JPG.
 * SVG is NOT supported. WEBP may fail.
 */
function resolveLocalLogoPath(logo_url) {
  if (!logo_url) return null;
  const s = String(logo_url).trim();
  if (!s) return null;

  // If it's a web URL, we can't load without downloading
  if (/^https?:\/\//i.test(s)) return null;

  // absolute path
  if (path.isAbsolute(s)) return fs.existsSync(s) ? s : null;

  const rel = s.replace(/^\/+/, "");

  const candidates = [
    // project root
    path.join(process.cwd(), rel),

    // common for Next public files
    path.join(process.cwd(), "public", rel),

    // common uploads folder (backend/uploads)
    path.join(process.cwd(), "uploads", rel.replace(/^uploads\//, "")),
    path.join(process.cwd(), "uploads", rel),

    // common build dirs
    path.join(process.cwd(), "src", rel),
    path.join(process.cwd(), "dist", rel),

    // relative to this controller (src/controllers)
    path.join(__dirname, "..", "..", "public", rel),
    path.join(__dirname, "..", "..", "uploads", rel.replace(/^uploads\//, "")),
    path.join(__dirname, "..", "..", "uploads", rel),
    path.join(__dirname, "..", "..", rel),

    // one more level up (in case dist/controllers)
    path.join(__dirname, "..", "..", "..", "public", rel),
    path.join(__dirname, "..", "..", "..", "uploads", rel.replace(/^uploads\//, "")),
    path.join(__dirname, "..", "..", "..", "uploads", rel),
    path.join(__dirname, "..", "..", "..", rel),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

function isPdfKitSupportedImage(filePath) {
  const ext = (path.extname(filePath || "") || "").toLowerCase();
  // ✅ safest: png/jpg/jpeg
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") return true;
  // svg not supported
  if (ext === ".svg") return false;
  // webp often fails
  if (ext === ".webp") return false;
  // unknown -> likely fail
  return false;
}

function companyAddressLine(company) {
  const parts = [
    company?.address_line1,
    company?.address_line2,
    [company?.city, company?.state].filter(Boolean).join(", ") || null,
    company?.pincode ? `PIN: ${company.pincode}` : null,
  ].filter(Boolean);
  return parts.join(" | ");
}

function companyContactLine(company) {
  const parts = [
    company?.phone_primary ? `Phone: ${company.phone_primary}` : null,
    company?.phone_secondary ? `Alt: ${company.phone_secondary}` : null,
    company?.email ? `Email: ${company.email}` : null,
    company?.website ? `Web: ${company.website}` : null,
  ].filter(Boolean);
  return parts.join("  •  ");
}

/* =========================================================
   POST /api/bundle-dispatches
   ========================================================= */
exports.createDispatch = async (request, reply) => {
  const body = request.body || {};
  const bundle_id = num(body.bundle_id);
  const bundle_issue_id = body.bundle_issue_id ? num(body.bundle_issue_id) : null;

  const dispatch_date = cleanStr(body.dispatch_date);
  if (!bundle_id) return reply.code(400).send({ message: "bundle_id is required" });
  if (!dispatch_date) return reply.code(400).send({ message: "dispatch_date is required (YYYY-MM-DD)" });

  const t = await sequelize.transaction();
  try {
    const bundle = await Bundle.findByPk(bundle_id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!bundle) {
      await t.rollback();
      return reply.code(404).send({ message: "Bundle not found" });
    }

    if (!["ISSUED", "DISPATCHED", "DELIVERED"].includes(String(bundle.status || "").toUpperCase())) {
      await t.rollback();
      return reply
        .code(400)
        .send({ message: `Bundle must be ISSUED before dispatch (current: ${bundle.status})` });
    }

    // validate issue
    if (bundle_issue_id) {
      const issue = await BundleIssue.findOne({
        where: { id: bundle_issue_id, bundle_id },
        transaction: t,
      });
      if (!issue) {
        await t.rollback();
        return reply.code(404).send({ message: "BundleIssue not found for this bundle" });
      }
    }

    // validate transport
    const transport_id = body.transport_id ? num(body.transport_id) : null;
    if (transport_id) {
      const transport = await Transport.findByPk(transport_id, { transaction: t });
      if (!transport) {
        await t.rollback();
        return reply.code(404).send({ message: "Transport not found" });
      }
    }

    // challan_no: if provided use it else auto-generate
    let challan_no = cleanStr(body.challan_no);
    if (challan_no) {
      const exists = await BundleDispatch.findOne({ where: { challan_no }, transaction: t });
      if (exists) {
        await t.rollback();
        return reply.code(400).send({ message: "challan_no already exists, please use different" });
      }
    } else {
      challan_no = await generateUniqueChallanNo({ t });
    }

    const row = await BundleDispatch.create(
      {
        challan_no,
        bundle_id,
        bundle_issue_id,
        transport_id,
        vehicle_no: cleanStr(body.vehicle_no),
        driver_name: cleanStr(body.driver_name),
        driver_mobile: cleanStr(body.driver_mobile),
        dispatch_date,
        expected_delivery_date: cleanStr(body.expected_delivery_date),
        delivered_date: null,
        status: "DISPATCHED",
        remarks: cleanStr(body.remarks),
      },
      { transaction: t }
    );

    // Update bundle status
    if (String(bundle.status || "").toUpperCase() !== "DELIVERED") {
      await bundle.update({ status: "DISPATCHED" }, { transaction: t });
    }

    await t.commit();
    return reply.send({ message: "Dispatch created", row });
  } catch (err) {
    request.log.error(err);
    await t.rollback();
    return reply.code(500).send({ message: "Internal Server Error" });
  }
};

/* =========================================================
   PATCH /api/bundle-dispatches/:id/status
   ========================================================= */
exports.updateStatus = async (request, reply) => {
  const id = num(request.params?.id);
  const body = request.body || {};
  const status = String(body.status || "").toUpperCase();

  if (!id) return reply.code(400).send({ message: "Invalid dispatch id" });
  if (!["DISPATCHED", "PARTIALLY_DELIVERED", "DELIVERED"].includes(status)) {
    return reply.code(400).send({ message: "Invalid status" });
  }

  const t = await sequelize.transaction();
  try {
    const row = await BundleDispatch.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!row) {
      await t.rollback();
      return reply.code(404).send({ message: "Dispatch not found" });
    }

    const patch = { status };

    if (status === "DELIVERED") {
      patch.delivered_date = cleanStr(body.delivered_date) || todayISO();
    } else if (typeof body.delivered_date !== "undefined") {
      patch.delivered_date = cleanStr(body.delivered_date);
    }

    if (typeof body.transport_id !== "undefined") {
      const transport_id = body.transport_id ? num(body.transport_id) : null;
      if (transport_id) {
        const transport = await Transport.findByPk(transport_id, { transaction: t });
        if (!transport) {
          await t.rollback();
          return reply.code(404).send({ message: "Transport not found" });
        }
      }
      patch.transport_id = transport_id;
    }

    if (typeof body.vehicle_no !== "undefined") patch.vehicle_no = cleanStr(body.vehicle_no);
    if (typeof body.driver_name !== "undefined") patch.driver_name = cleanStr(body.driver_name);
    if (typeof body.driver_mobile !== "undefined") patch.driver_mobile = cleanStr(body.driver_mobile);
    if (typeof body.expected_delivery_date !== "undefined")
      patch.expected_delivery_date = cleanStr(body.expected_delivery_date);
    if (typeof body.remarks !== "undefined") patch.remarks = cleanStr(body.remarks);

    // allow updating challan_no
    if (typeof body.challan_no !== "undefined") {
      const challan_no = cleanStr(body.challan_no);
      if (challan_no && challan_no !== row.challan_no) {
        const exists = await BundleDispatch.findOne({
          where: { challan_no, id: { [Op.ne]: row.id } },
          transaction: t,
        });
        if (exists) {
          await t.rollback();
          return reply.code(400).send({ message: "challan_no already exists, please use different" });
        }
      }
      patch.challan_no = challan_no;
    }

    await row.update(patch, { transaction: t });

    // update bundle status
    const bundle = await Bundle.findByPk(row.bundle_id, { transaction: t, lock: t.LOCK.UPDATE });
    if (bundle) {
      if (status === "DELIVERED") {
        await bundle.update({ status: "DELIVERED" }, { transaction: t });
      } else {
        await bundle.update({ status: "DISPATCHED" }, { transaction: t });
      }
    }

    await t.commit();
    return reply.send({ message: "Dispatch updated", row });
  } catch (err) {
    request.log.error(err);
    await t.rollback();
    return reply.code(500).send({ message: "Internal Server Error" });
  }
};

/* =========================================================
   GET /api/bundle-dispatches?bundle_id=&bundle_issue_id=&status=&q=
   ========================================================= */
exports.listDispatches = async (request, reply) => {
  try {
    const { bundle_id, bundle_issue_id, status, q } = request.query || {};
    const where = {};

    if (bundle_id) where.bundle_id = num(bundle_id);
    if (bundle_issue_id) where.bundle_issue_id = num(bundle_issue_id);
    if (status) where.status = String(status).toUpperCase();

    if (q && String(q).trim()) {
      const s = String(q).trim();
      where[Op.or] = [
        { challan_no: { [Op.like]: `%${s}%` } },
        { vehicle_no: { [Op.like]: `%${s}%` } },
        { driver_name: { [Op.like]: `%${s}%` } },
        { driver_mobile: { [Op.like]: `%${s}%` } },
      ];
    }

    const rows = await BundleDispatch.findAll({
      where,
      order: [["id", "DESC"]],
      include: [
        {
          model: Bundle,
          as: "bundle",
          include: [{ model: School, as: "school", attributes: ["id", "name"] }],
        },
        { model: BundleIssue, as: "issue" },
        { model: Transport, as: "transport" },
      ],
    });

    return reply.send({ rows });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ message: "Internal Server Error" });
  }
};

/* =========================================================
   GET /api/bundle-dispatches/:id/challan
   Delivery Challan PDF
   ========================================================= */
exports.downloadChallanPdf = async (request, reply) => {
  const dispatchId = num(request.params?.id);
  if (!dispatchId) return reply.code(400).send({ message: "Invalid dispatch id" });

  try {
    const dispatch = await BundleDispatch.findByPk(dispatchId, {
      include: [
        {
          model: Bundle,
          as: "bundle",
          include: [
            { model: School, as: "school", attributes: ["id", "name"] },
            {
              model: BundleItem,
              as: "items",
              include: [
                {
                  model: Book,
                  as: "book",
                  attributes: ["id", "title", "code", "subject", "class_name"],
                },
              ],
            },
          ],
        },
        { model: BundleIssue, as: "issue" },
        { model: Transport, as: "transport" },
      ],
    });

    if (!dispatch) return reply.code(404).send({ message: "Dispatch not found" });

    // Resolve issued-to label
    let issuedToLabel = "";
    if (dispatch.issue) {
      if (dispatch.issue.issued_to_type === "SCHOOL") {
        const s = await School.findByPk(dispatch.issue.issued_to_id, { attributes: ["id", "name"] });
        issuedToLabel = s ? `School: ${s.name}` : `School ID: ${dispatch.issue.issued_to_id}`;
      } else if (dispatch.issue.issued_to_type === "DISTRIBUTOR") {
        const d = await Distributor.findByPk(dispatch.issue.issued_to_id, { attributes: ["id", "name"] });
        issuedToLabel = d ? `Distributor: ${d.name}` : `Distributor ID: ${dispatch.issue.issued_to_id}`;
      }
    }

    // Prefer default active profile
    const company =
      (await CompanyProfile.findOne({ where: { is_default: true, is_active: true }, order: [["id", "DESC"]] })) ||
      (await CompanyProfile.findOne({ where: { is_active: true }, order: [["id", "DESC"]] })) ||
      (await CompanyProfile.findOne({ order: [["id", "DESC"]] }));

    const bundle = dispatch.bundle;
    const issueNo = dispatch.issue?.issue_no || "-";
    const bundleId = bundle?.id || "-";
    const challanNo = dispatch.challan_no || `Dispatch-${dispatch.id}`;

    // prepare items
    const items = (bundle?.items || []).map((it) => {
      const title = it.book?.title || "-";
      const cls = it.book?.class_name || it.class_name || "-";
      const subject = it.book?.subject || it.subject || "-";
      const code = it.book?.code || it.code || "-";
      const qty = num(it.issued_qty) > 0 ? num(it.issued_qty) : num(it.required_qty);
      return { code, title, cls, subject, qty };
    });

    const pdfBuffer = await buildPdfBuffer((doc) => {
      const leftX = doc.page.margins.left;
      const rightX = doc.page.width - doc.page.margins.right;
      const pageW = rightX - leftX;

      // page numbers
      let pageNo = 1;
      const drawFooter = () => {
        const footerY = doc.page.height - doc.page.margins.bottom + 6;
        doc
          .font("Helvetica")
          .fontSize(8)
          .fillColor("#6B7280")
          .text(`Page ${pageNo}`, leftX, footerY, { width: pageW, align: "right" })
          .fillColor("#000000");
      };

      doc.on("pageAdded", () => {
        pageNo += 1;
      });

      const drawHeader = () => {
        const headerTop = doc.page.margins.top;
        const logoBox = 60;

        const infoX = leftX + logoBox + 12;
        const infoW = pageW - (logoBox + 12);

        // --- Logo ---
        const logoPath = resolveLocalLogoPath(company?.logo_url);
        const canDrawLogo = logoPath && isPdfKitSupportedImage(logoPath);

        if (canDrawLogo) {
          try {
            const imgBuf = fs.readFileSync(logoPath);
            doc.image(imgBuf, leftX, headerTop, { fit: [logoBox, logoBox] });
          } catch (e) {
            // placeholder
            doc.rect(leftX, headerTop, logoBox, logoBox).lineWidth(0.5).strokeColor("#DDDDDD").stroke().strokeColor("#000000");
          }
        } else {
          // placeholder (also covers svg/webp)
          doc.rect(leftX, headerTop, logoBox, logoBox).lineWidth(0.5).strokeColor("#DDDDDD").stroke().strokeColor("#000000");
        }

        // --- Company info ---
        doc
          .font("Helvetica-Bold")
          .fontSize(16)
          .fillColor("#111827")
          .text(company?.name || "COMPANY", infoX, headerTop + 2, { width: infoW, align: "left" });

        const addr = companyAddressLine(company);
        const contact = companyContactLine(company);

        doc.font("Helvetica").fontSize(9).fillColor("#374151");
        if (addr) doc.text(addr, infoX, headerTop + 22, { width: infoW });
        if (contact) doc.text(contact, infoX, headerTop + 36, { width: infoW });
        if (company?.gstin) doc.text(`GSTIN: ${company.gstin}`, infoX, headerTop + 50, { width: infoW });

        doc.fillColor("#000000");

        const headerBottomY = headerTop + logoBox + 10;
        doc
          .moveTo(leftX, headerBottomY)
          .lineTo(rightX, headerBottomY)
          .lineWidth(0.8)
          .strokeColor("#E5E7EB")
          .stroke()
          .strokeColor("#000000");

        doc.y = headerBottomY + 8;
      };

      const drawTitleBar = (title, subTitle) => {
        const barH = 32;
        const y = doc.y;

        doc.save();
        doc.rect(leftX, y, pageW, barH).fillColor("#F3F4F6").fill().restore();

        doc.font("Helvetica-Bold").fontSize(13).fillColor("#111827").text(title, leftX, y + 7, {
          width: pageW,
          align: "center",
        });

        doc.font("Helvetica-Bold").fontSize(10).fillColor("#111827").text(subTitle, leftX, y + 19, {
          width: pageW,
          align: "center",
        });

        doc.fillColor("#000000");
        doc.y = y + barH + 8;
      };

      // ✅ One-line label:value (two columns)
      const boxRowInline = (leftText, rightText) => {
        const y = doc.y;
        const boxH = 26;
        const half = pageW / 2;

        doc.rect(leftX, y, pageW, boxH).lineWidth(0.8).strokeColor("#E5E7EB").stroke().strokeColor("#000000");
        doc.moveTo(leftX + half, y).lineTo(leftX + half, y + boxH).lineWidth(0.8).strokeColor("#E5E7EB").stroke().strokeColor("#000000");

        doc.font("Helvetica").fontSize(10).fillColor("#111827");
        doc.text(leftText || "-", leftX + 10, y + 7, { width: half - 20 });
        doc.text(rightText || "-", leftX + half + 10, y + 7, { width: half - 20, align: "right" });

        doc.fillColor("#000000");
        doc.y = y + boxH + 6;
      };

      const sectionTitle = (t) => {
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#111827").text(t, leftX, doc.y);
        doc.moveDown(0.25);
        doc
          .moveTo(leftX, doc.y)
          .lineTo(rightX, doc.y)
          .lineWidth(0.6)
          .strokeColor("#E5E7EB")
          .stroke()
          .strokeColor("#000000");
        doc.moveDown(0.5);
      };

      // Table helpers
      const table = {
        col: { sno: 34, code: 70, cls: 60, qty: 52 },
        rowH: 18,
      };
      table.col.title = pageW - (table.col.sno + table.col.code + table.col.cls + table.col.qty);

      const drawTableHeader = () => {
        const y = doc.y;

        doc.save();
        doc.rect(leftX, y, pageW, table.rowH).fillColor("#F9FAFB").fill().restore();

        doc.rect(leftX, y, pageW, table.rowH).lineWidth(0.8).strokeColor("#E5E7EB").stroke().strokeColor("#000000");

        doc.font("Helvetica-Bold").fontSize(9).fillColor("#111827");
        doc.text("S.No", leftX + 6, y + 5, { width: table.col.sno - 12 });
        doc.text("Code", leftX + table.col.sno + 6, y + 5, { width: table.col.code - 12 });
        doc.text("Class", leftX + table.col.sno + table.col.code + 6, y + 5, { width: table.col.cls - 12 });
        doc.text("Title / Subject", leftX + table.col.sno + table.col.code + table.col.cls + 6, y + 5, { width: table.col.title - 12 });
        doc.text("Qty", leftX + pageW - table.col.qty + 6, y + 5, { width: table.col.qty - 12, align: "right" });

        doc.fillColor("#000000");
        doc.y = y + table.rowH;
      };

      // ✅ less aggressive bottom reserve
      const ensureSpace = (needed = 20) => {
        const bottomLimit = doc.page.height - doc.page.margins.bottom - 30; // was 70
        if (doc.y + needed > bottomLimit) {
          drawFooter();
          doc.addPage();
          drawHeader();
        }
      };

      // ----------- Document Build -----------
      drawHeader();
      drawTitleBar("DELIVERY CHALLAN", `Challan No: ${challanNo}`);

      boxRowInline(`Dispatch ID: ${dispatch.id}`, `Dispatch Date: ${dispatch.dispatch_date || "-"}`);
      boxRowInline(`Bundle ID: ${bundleId}`, `Issue No: ${issueNo}`);
      boxRowInline(`Academic Session: ${bundle?.academic_session || "-"}`, `Status: ${dispatch.status || "-"}`);

      // Party
      sectionTitle("Delivery Details");
      const schoolName = bundle?.school?.name || "-";
      doc.font("Helvetica").fontSize(10).fillColor("#111827");
      doc.text(`Deliver To: ${issuedToLabel || `School: ${schoolName}`}`, leftX, doc.y, { width: pageW });
      doc.text(`School Name: ${schoolName}`, leftX, doc.y + 2, { width: pageW });
      doc.moveDown(0.6);

      // Transport
      sectionTitle("Transport Details");
      doc.font("Helvetica").fontSize(10).fillColor("#111827");
      doc.text(`Transport: ${dispatch.transport?.name || "-"}`, leftX, doc.y, { width: pageW });
      doc.text(`Vehicle No: ${dispatch.vehicle_no || "-"}`, leftX, doc.y + 2, { width: pageW });
      doc.text(`Driver: ${dispatch.driver_name || "-"}    Mobile: ${dispatch.driver_mobile || "-"}`, leftX, doc.y + 2, { width: pageW });
      if (dispatch.expected_delivery_date) doc.text(`Expected Delivery: ${dispatch.expected_delivery_date}`, leftX, doc.y + 2, { width: pageW });
      doc.moveDown(0.6);

      // Items
      sectionTitle("Items");
      drawTableHeader();

      doc.font("Helvetica").fontSize(9).fillColor("#111827");

      let totalQty = 0;
      items.forEach((it, idx) => {
        ensureSpace(table.rowH + 8);

        // if new page happened, redraw table header
        if (doc.y < 160) {
          doc.moveDown(0.2);
          drawTableHeader();
        }

        const y = doc.y;

        doc.rect(leftX, y, pageW, table.rowH).lineWidth(0.6).strokeColor("#E5E7EB").stroke().strokeColor("#000000");
        doc.text(String(idx + 1), leftX + 6, y + 4, { width: table.col.sno - 12 });
        doc.text(it.code || "-", leftX + table.col.sno + 6, y + 4, { width: table.col.code - 12 });
        doc.text(it.cls || "-", leftX + table.col.sno + table.col.code + 6, y + 4, { width: table.col.cls - 12 });

        const titleSubject = `${it.title || "-"}${it.subject && it.subject !== "-" ? " | " + it.subject : ""}`;
        doc.text(titleSubject, leftX + table.col.sno + table.col.code + table.col.cls + 6, y + 4, { width: table.col.title - 12 });

        doc.text(String(it.qty || 0), leftX + pageW - table.col.qty + 6, y + 4, { width: table.col.qty - 12, align: "right" });

        doc.y = y + table.rowH;
        totalQty += num(it.qty);
      });

      ensureSpace(50);

      // Total
      doc.moveDown(0.4);
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#111827").text(`Total Qty: ${totalQty}`, leftX, doc.y, {
        width: pageW,
        align: "right",
      });
      doc.fillColor("#000000");
      doc.moveDown(0.6);

      // Remarks
      if (dispatch.remarks) {
        ensureSpace(60);
        sectionTitle("Remarks");
        doc.font("Helvetica").fontSize(10).fillColor("#111827").text(dispatch.remarks, leftX, doc.y, { width: pageW });
        doc.fillColor("#000000");
        doc.moveDown(0.6);
      }

      // ✅ Signature block ONLY if space, else new page
      const signatureHeight = 52;
      const bottomLimitForSign = doc.page.height - doc.page.margins.bottom - signatureHeight - 10;
      if (doc.y > bottomLimitForSign) {
        drawFooter();
        doc.addPage();
        drawHeader();
      }

      const signY = doc.page.height - doc.page.margins.bottom - 42;
      doc
        .moveTo(leftX, signY - 12)
        .lineTo(leftX + pageW, signY - 12)
        .lineWidth(0.6)
        .strokeColor("#E5E7EB")
        .stroke()
        .strokeColor("#000000");

      doc.font("Helvetica").fontSize(10).fillColor("#111827");
      doc.text("Receiver Signature", leftX, signY, { width: pageW / 2 });
      doc.text("Authorized Signature", leftX + pageW / 2, signY, { width: pageW / 2, align: "right" });
      doc.fillColor("#000000");

      drawFooter();
    });

    const safeChallan = String(challanNo || `Dispatch-${dispatch.id}`).replace(/[^\w\-]+/g, "_");
    const filename = `Delivery-Challan-${safeChallan}.pdf`;
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", `inline; filename="${filename}"`);
    return reply.send(pdfBuffer);
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ message: "Failed to generate challan PDF" });
  }
};
