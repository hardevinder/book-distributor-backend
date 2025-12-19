"use strict";

const {
  SchoolBookRequirement,
  School,
  Book,
  InventoryBatch,
  InventoryTxn,
  sequelize,
} = require("../models");

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

exports.schoolAvailability = async (request, reply) => {
  try {
    const { schoolId, academic_session } = request.query || {};

    if (!schoolId) return reply.code(400).send({ message: "schoolId is required" });

    const school = await School.findByPk(Number(schoolId), { attributes: ["id", "name"] });
    if (!school) return reply.code(404).send({ message: "School not found" });

    // ✅ Requirements: book-wise SUM(required_copies) for this school (+ optional session)
    const reqWhere = { school_id: Number(schoolId) };
    if (academic_session) reqWhere.academic_session = String(academic_session);

    const reqRows = await SchoolBookRequirement.findAll({
      where: reqWhere,
      attributes: [
        "book_id",
        [sequelize.fn("SUM", sequelize.col("required_copies")), "required_qty"],
      ],
      include: [
        {
          model: Book,
          as: "book",
          attributes: ["id", "title", "class_name", "subject", "code"],
        },
      ],
      group: [
        "book_id",
        "book.id",
        "book.title",
        "book.class_name",
        "book.subject",
        "book.code",
      ],
    });

    // ✅ Inventory: book-wise SUM(available_qty) across all batches (global stock)
    const invRows = await InventoryBatch.findAll({
      attributes: [
        "book_id",
        [sequelize.fn("SUM", sequelize.col("available_qty")), "available_qty"],
      ],
      group: ["book_id"],
      raw: true,
    });

    const invMap = new Map(invRows.map((r) => [Number(r.book_id), num(r.available_qty)]));

    /* -------------------------------------------------------
       ✅ Txns: reserved & issued
       - SCHOOL reserved/issued (if you use it somewhere)
       - PLUS BUNDLE reserved (global reservations done by bundles)
    -------------------------------------------------------- */

    // 1) SCHOOL wise txns (your existing behavior)
    const schoolTxnRows = await InventoryTxn.findAll({
      where: { ref_type: "SCHOOL", ref_id: Number(schoolId) },
      attributes: [
        "book_id",
        [
          sequelize.literal(`
            SUM(CASE WHEN txn_type='RESERVE' THEN qty ELSE 0 END) -
            SUM(CASE WHEN txn_type='UNRESERVE' THEN qty ELSE 0 END)
          `),
          "reserved_qty",
        ],
        [
          sequelize.literal(`SUM(CASE WHEN txn_type='OUT' THEN qty ELSE 0 END)`),
          "issued_qty",
        ],
      ],
      group: ["book_id"],
      raw: true,
    });

    const schoolReservedMap = new Map(
      schoolTxnRows.map((r) => [Number(r.book_id), num(r.reserved_qty)])
    );
    const issuedMap = new Map(
      schoolTxnRows.map((r) => [Number(r.book_id), num(r.issued_qty)])
    );

    // 2) ✅ BUNDLE wise reserved (global)
    const bundleTxnRows = await InventoryTxn.findAll({
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
      bundleTxnRows.map((r) => [Number(r.book_id), Math.max(0, num(r.reserved_qty))])
    );

    // ✅ Final reserved = bundleReserved (global) + schoolReserved (if you want to show it too)
    // If you only want to show global reservation effect, keep only bundleReserved.
    const reservedMap = new Map();
    for (const [bookId, qty] of bundleReservedMap.entries()) reservedMap.set(bookId, qty);
    for (const [bookId, qty] of schoolReservedMap.entries())
      reservedMap.set(bookId, (reservedMap.get(bookId) || 0) + qty);

    // ✅ Build: Class -> Books
    const classMap = new Map();

    for (const row of reqRows) {
      const book = row.book;
      if (!book) continue;

      const bookId = Number(book.id);
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

        required_qty: num(row.get("required_qty")),
        available_qty: availableQty,
        reserved_qty: reservedQty,
        issued_qty: issuedQty,

        // ✅ helps frontend
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
