"use strict";

const { Op } = require("sequelize");

const {
  SchoolBookRequirement,
  School,
  Book,
  Publisher,
  Supplier,
  InventoryBatch,
  InventoryTxn,
  Bundle,
  BundleIssue,

  // ✅ DIRECT purchases
  SupplierReceipt,
  SupplierReceiptItem,

  sequelize,
} = require("../models");

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const safeStr = (v) => String(v ?? "").trim();

/**
 * Try fetching direct purchase book_ids with multiple possible aliases
 * so we don't crash if association alias differs.
 */
async function fetchDirectPurchaseBookIds({ sId, academic_session, request }) {
  if (!SupplierReceipt || !SupplierReceiptItem) return [];

  const dpWhere = {
    school_id: sId,
    school_order_id: { [Op.or]: [null, 0] },
    status: "received",
  };
  if (academic_session) dpWhere.academic_session = String(academic_session);

  const aliasCandidates = ["receipt", "supplierReceipt", "SupplierReceipt"];

  for (const asAlias of aliasCandidates) {
    try {
      const dpRows = await SupplierReceiptItem.findAll({
        attributes: ["book_id"],
        include: [
          {
            model: SupplierReceipt,
            as: asAlias,
            required: true,
            attributes: [],
            where: dpWhere,
          },
        ],
        group: ["book_id"],
        raw: true,
      });

      const ids = (dpRows || []).map((r) => Number(r.book_id)).filter(Boolean);
      if (ids.length) return ids;

      // even if empty, it means join worked
      return [];
    } catch (e) {
      // try next alias
      request?.log?.error?.(e);
    }
  }

  // If no alias works, return empty (no crash)
  console.error("DIRECT purchase join failed in schoolAvailability (all alias attempts).");
  return [];
}

exports.schoolAvailability = async (request, reply) => {
  try {
    // ✅ accept both school_id (preferred) and schoolId (legacy)
    const { school_id, schoolId, academic_session } = request.query || {};
    const sId = Number(school_id ?? schoolId);

    if (!sId) return reply.code(400).send({ message: "school_id is required" });

    const school = await School.findByPk(sId, { attributes: ["id", "name"] });
    if (!school) return reply.code(404).send({ message: "School not found" });

    /* =========================
       1) Requirements (school-wise)
       ========================= */
    const reqWhere = { school_id: sId };
    if (academic_session) reqWhere.academic_session = String(academic_session);

    const reqAggRows = await SchoolBookRequirement.findAll({
      where: reqWhere,
      attributes: ["book_id", [sequelize.fn("SUM", sequelize.col("required_copies")), "required_qty"]],
      group: ["book_id"],
      raw: true,
    });

    const reqBookIds = (reqAggRows || []).map((r) => Number(r.book_id)).filter(Boolean);
    const reqMap = new Map((reqAggRows || []).map((r) => [Number(r.book_id), num(r.required_qty)]));

    /* =========================
       1.5) ✅ DIRECT PURCHASE books (no order)
       ========================= */
    const directBookIds = await fetchDirectPurchaseBookIds({ sId, academic_session, request });

    /* =========================
       1.6) Merge ids
       ========================= */
    const allBookIds = [...new Set([...(reqBookIds || []), ...(directBookIds || [])])].filter(Boolean);

    /* =========================
       1.7) Book master + publisher + supplier
       ========================= */
    const books = allBookIds.length
      ? await Book.findAll({
          where: { id: { [Op.in]: allBookIds } },
          attributes: ["id", "title", "class_name", "subject", "code"],
          include: [
            { model: Publisher, as: "publisher", attributes: ["id", "name"], required: false },
            { model: Supplier, as: "supplier", attributes: ["id", "name"], required: false },
          ],
        })
      : [];

    const bookMap = new Map((books || []).map((b) => [Number(b.id), b]));

    /* =========================
       2) Inventory available (global)
       ✅ IMPORTANT: filter to only needed book_ids (fix + faster)
       ========================= */
    const invRows = allBookIds.length
      ? await InventoryBatch.findAll({
          attributes: ["book_id", [sequelize.fn("SUM", sequelize.col("available_qty")), "available_qty"]],
          where: { book_id: { [Op.in]: allBookIds } },
          group: ["book_id"],
          raw: true,
        })
      : [];

    const invMap = new Map((invRows || []).map((r) => [Number(r.book_id), num(r.available_qty)]));

    /* =========================
       3) Reserved
       ========================= */

    // 3a) School reserved (legacy)
    const schoolReservedRows = await InventoryTxn.findAll({
      where: { ref_type: "SCHOOL", ref_id: sId },
      attributes: [
        "book_id",
        [
          sequelize.literal(`
            SUM(CASE WHEN txn_type='RESERVE' THEN qty ELSE 0 END) -
            SUM(CASE WHEN txn_type='UNRESERVE' THEN qty ELSE 0 END)
          `),
          "reserved_qty",
        ],
      ],
      group: ["book_id"],
      raw: true,
    });

    const schoolReservedMap = new Map(
      (schoolReservedRows || []).map((r) => [Number(r.book_id), Math.max(0, num(r.reserved_qty))])
    );

    // 3b) Bundle reserved (global)
    const bundleReservedRows = await InventoryTxn.findAll({
      where: { ref_type: "BUNDLE" },
      attributes: [
        "book_id",
        [
          sequelize.literal(`
            SUM(CASE WHEN txn_type='RESERVE' THEN qty ELSE 0 END) -
            SUM(CASE WHEN txn_type='UNRESERVE' THEN qty ELSE 0 END)
          `),
          "reserved_qty",
        ],
      ],
      group: ["book_id"],
      raw: true,
    });

    const bundleReservedMap = new Map(
      (bundleReservedRows || []).map((r) => [Number(r.book_id), Math.max(0, num(r.reserved_qty))])
    );

    const reservedMap = new Map();
    for (const [bookId, qty] of bundleReservedMap.entries()) reservedMap.set(bookId, qty);
    for (const [bookId, qty] of schoolReservedMap.entries()) {
      reservedMap.set(bookId, (reservedMap.get(bookId) || 0) + qty);
    }

    /* =========================
       4) Issued Qty
       ========================= */
    const bundleWhere = { school_id: sId };
    if (academic_session) bundleWhere.academic_session = String(academic_session);

    const bundleRows = await Bundle.findAll({
      where: bundleWhere,
      attributes: ["id"],
      raw: true,
    });
    const bundleIds = (bundleRows || []).map((b) => Number(b.id)).filter(Boolean);

    const issuedMap = new Map();

    if (bundleIds.length) {
      const issueRows = await BundleIssue.findAll({
        where: {
          bundle_id: { [Op.in]: bundleIds },
          [Op.or]: [{ status: { [Op.ne]: "CANCELLED" } }, { status: { [Op.is]: null } }],
        },
        attributes: ["id"],
        raw: true,
      });

      const issueIds = (issueRows || []).map((x) => Number(x.id)).filter(Boolean);

      if (issueIds.length) {
        const issuedTxnRows = await InventoryTxn.findAll({
          where: {
            ref_type: "BUNDLE_ISSUE",
            ref_id: { [Op.in]: issueIds },
            txn_type: "OUT",
          },
          attributes: ["book_id", [sequelize.fn("SUM", sequelize.col("qty")), "issued_qty"]],
          group: ["book_id"],
          raw: true,
        });

        for (const r of issuedTxnRows || []) {
          issuedMap.set(Number(r.book_id), num(r.issued_qty));
        }
      }
    }

    const schoolIssuedRows = await InventoryTxn.findAll({
      where: { ref_type: "SCHOOL", ref_id: sId, txn_type: "OUT" },
      attributes: ["book_id", [sequelize.fn("SUM", sequelize.col("qty")), "issued_qty"]],
      group: ["book_id"],
      raw: true,
    });

    for (const r of schoolIssuedRows || []) {
      const bookId = Number(r.book_id);
      issuedMap.set(bookId, (issuedMap.get(bookId) || 0) + num(r.issued_qty));
    }

    /* =========================
       5) Build response
       ========================= */
    const directSet = new Set(directBookIds);
    const reqSet = new Set(reqBookIds);

    const classMap = new Map();

    for (const bookIdRaw of allBookIds) {
      const bookId = Number(bookIdRaw);
      const book = bookMap.get(bookId);
      if (!book) continue;

      const className = safeStr(book.class_name) || "Unknown";
      if (!classMap.has(className)) classMap.set(className, []);

      const availableQty = invMap.get(bookId) || 0;
      const reservedQty = reservedMap.get(bookId) || 0;
      const issuedQty = issuedMap.get(bookId) || 0;
      const freeQty = Math.max(0, availableQty - reservedQty);

      const hasReq = reqSet.has(bookId) && (reqMap.get(bookId) || 0) > 0;
      const hasDirect = directSet.has(bookId);

      let source = "REQ";
      if (hasReq && hasDirect) source = "BOTH";
      else if (hasDirect && !hasReq) source = "DIRECT";

      classMap.get(className).push({
        book_id: bookId,
        title: book.title,
        subject: book.subject || null,
        code: book.code || null,

        publisher: book.publisher ? { id: book.publisher.id, name: book.publisher.name } : null,
        supplier: book.supplier ? { id: book.supplier.id, name: book.supplier.name } : null,

        required_qty: reqMap.get(bookId) || 0,
        available_qty: availableQty,
        reserved_qty: reservedQty,
        issued_qty: issuedQty,
        free_qty: freeQty,

        // ✅ NEW (optional for UI)
        source,
      });
    }

    const classes = Array.from(classMap.entries())
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }))
      .map(([class_name, booksArr]) => ({
        class_name,
        books: (booksArr || []).sort((x, y) => (x.title || "").localeCompare(y.title || "")),
      }));

    return reply.send({
      mode: "SCHOOL_AVAILABILITY",
      school,
      academic_session: academic_session || null,
      classes,
    });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ message: "Internal Server Error" });
  }
};
