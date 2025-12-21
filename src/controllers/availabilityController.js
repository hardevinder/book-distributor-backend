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
  sequelize,
} = require("../models");

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

exports.schoolAvailability = async (request, reply) => {
  try {
    const { schoolId, academic_session } = request.query || {};
    const sId = Number(schoolId);

    if (!sId) return reply.code(400).send({ message: "schoolId is required" });

    const school = await School.findByPk(sId, { attributes: ["id", "name"] });
    if (!school) return reply.code(404).send({ message: "School not found" });

    /* =========================
       1) Requirements (school-wise) - grouped
       ========================= */
    const reqWhere = { school_id: sId };
    if (academic_session) reqWhere.academic_session = String(academic_session);

    // 1a) aggregate requirement qty per book_id (RAW)
    const reqAggRows = await SchoolBookRequirement.findAll({
      where: reqWhere,
      attributes: [
        "book_id",
        [sequelize.fn("SUM", sequelize.col("required_copies")), "required_qty"],
      ],
      group: ["book_id"],
      raw: true,
    });

    const reqBookIds = reqAggRows.map((r) => Number(r.book_id)).filter(Boolean);

    // 1b) fetch book details + publisher + supplier
    const books = reqBookIds.length
      ? await Book.findAll({
          where: { id: { [Op.in]: reqBookIds } },
          attributes: ["id", "title", "class_name", "subject", "code"],
          include: [
            {
              model: Publisher,
              as: "publisher",
              attributes: ["id", "name"],
              required: false,
            },
            {
              model: Supplier,
              as: "supplier",
              attributes: ["id", "name"],
              required: false,
            },
          ],
        })
      : [];

    const bookMap = new Map(books.map((b) => [Number(b.id), b]));

    /* =========================
       2) Inventory available (global)
       ========================= */
    const invRows = await InventoryBatch.findAll({
      attributes: [
        "book_id",
        [sequelize.fn("SUM", sequelize.col("available_qty")), "available_qty"],
      ],
      group: ["book_id"],
      raw: true,
    });

    const invMap = new Map(invRows.map((r) => [Number(r.book_id), num(r.available_qty)]));

    /* =========================
       3) Reserved
       ========================= */

    // 3a) School reserved (optional / legacy)
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
      schoolReservedRows.map((r) => [Number(r.book_id), Math.max(0, num(r.reserved_qty))])
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
      bundleReservedRows.map((r) => [Number(r.book_id), Math.max(0, num(r.reserved_qty))])
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
    const bundleIds = bundleRows.map((b) => Number(b.id)).filter(Boolean);

    const issuedMap = new Map();

    if (bundleIds.length) {
      const issueRows = await BundleIssue.findAll({
        where: {
          bundle_id: { [Op.in]: bundleIds },
          [Op.or]: [
            { status: { [Op.ne]: "CANCELLED" } },
            { status: { [Op.is]: null } },
          ],
        },
        attributes: ["id"],
        raw: true,
      });

      const issueIds = issueRows.map((x) => Number(x.id)).filter(Boolean);

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

        for (const r of issuedTxnRows) {
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

    for (const r of schoolIssuedRows) {
      const bookId = Number(r.book_id);
      issuedMap.set(bookId, (issuedMap.get(bookId) || 0) + num(r.issued_qty));
    }

    /* =========================
       5) Build class-wise response (+ publisher/supplier)
       ========================= */
    const classMap = new Map();

    for (const row of reqAggRows) {
      const bookId = Number(row.book_id);
      const book = bookMap.get(bookId);
      if (!book) continue;

      const className = book.class_name || "Unknown";
      if (!classMap.has(className)) classMap.set(className, []);

      const availableQty = invMap.get(bookId) || 0;
      const reservedQty = reservedMap.get(bookId) || 0;
      const issuedQty = issuedMap.get(bookId) || 0;
      const freeQty = Math.max(0, availableQty - reservedQty);

      classMap.get(className).push({
        book_id: bookId,
        title: book.title,
        subject: book.subject || null,
        code: book.code || null,

        publisher: book.publisher
          ? { id: book.publisher.id, name: book.publisher.name }
          : null,

        supplier: book.supplier
          ? { id: book.supplier.id, name: book.supplier.name }
          : null,

        required_qty: num(row.required_qty),
        available_qty: availableQty,
        reserved_qty: reservedQty,
        issued_qty: issuedQty,
        free_qty: freeQty,
      });
    }

    const classes = Array.from(classMap.entries())
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }))
      .map(([class_name, books]) => ({
        class_name,
        books: books.sort((x, y) => (x.title || "").localeCompare(y.title || "")),
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
