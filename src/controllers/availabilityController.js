"use strict";

const { Op } = require("sequelize");

const {
  SchoolBookRequirement,
  School,
  Book,
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
       1) Requirements (school-wise)
       ========================= */
    const reqWhere = { school_id: sId };
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
      group: ["book_id", "book.id", "book.title", "book.class_name", "book.subject", "book.code"],
    });

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
       - Bundles reserve globally (ref_type=BUNDLE)
       - School reserve (if you ever use it) (ref_type=SCHOOL)
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

    // Final reserved = bundle reserved + school reserved (keep this behavior)
    const reservedMap = new Map();
    for (const [bookId, qty] of bundleReservedMap.entries()) reservedMap.set(bookId, qty);
    for (const [bookId, qty] of schoolReservedMap.entries()) {
      reservedMap.set(bookId, (reservedMap.get(bookId) || 0) + qty);
    }

    /* =========================
       4) Issued Qty ✅ FIX
       We issued stock with:
         InventoryTxn: txn_type=OUT, ref_type=BUNDLE_ISSUE, ref_id=bundle_issue.id

       So to get school issued:
       - Find bundles for this school (+ session)
       - Find bundle issues for those bundles that are NOT cancelled
       - Sum InventoryTxn OUT for those issue IDs
       ========================= */

    // 4a) bundles of this school (and session if provided)
    const bundleWhere = { school_id: sId };
    if (academic_session) bundleWhere.academic_session = String(academic_session);

    const bundleRows = await Bundle.findAll({
      where: bundleWhere,
      attributes: ["id"],
      raw: true,
    });
    const bundleIds = bundleRows.map((b) => Number(b.id)).filter(Boolean);

    // issuedMap final
    const issuedMap = new Map();

    if (bundleIds.length) {
      // 4b) issue IDs for those bundles (exclude cancelled)
      // NOTE: Your API response shows issue.status exists in DB.
      // If model is missing status column, still works if DB has it, but best to add it in model.
      const issueRows = await BundleIssue.findAll({
        where: {
          bundle_id: { [Op.in]: bundleIds },
          [Op.or]: [
            { status: { [Op.ne]: "CANCELLED" } },
            { status: { [Op.is]: null } }, // safety if old rows have null
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
          attributes: [
            "book_id",
            [sequelize.fn("SUM", sequelize.col("qty")), "issued_qty"],
          ],
          group: ["book_id"],
          raw: true,
        });

        for (const r of issuedTxnRows) {
          issuedMap.set(Number(r.book_id), num(r.issued_qty));
        }
      }
    }

    // 4c) OPTIONAL: if you also have direct SCHOOL OUT txns, add them too
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
       5) Build class-wise response
       ========================= */
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
