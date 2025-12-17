"use strict";

const {
  SchoolBookRequirement,
  School,
  Book,
  InventoryBatch,
  sequelize,
} = require("../models");

exports.schoolAvailability = async (request, reply) => {
  try {
    const { schoolId, academic_session } = request.query || {};

    if (!schoolId) {
      return reply.code(400).send({ message: "schoolId is required" });
    }

    const school = await School.findByPk(schoolId, {
      attributes: ["id", "name"],
    });
    if (!school) {
      return reply.code(404).send({ message: "School not found" });
    }

    // ✅ Requirements: book-wise SUM(required_copies) for this school (+ optional session)
    const reqWhere = { school_id: schoolId };
    if (academic_session) reqWhere.academic_session = academic_session;

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
      group: ["book_id", "book.id"],
    });

    // ✅ Inventory: book-wise SUM(available_qty) across all batches
    const invRows = await InventoryBatch.findAll({
      attributes: [
        "book_id",
        [sequelize.fn("SUM", sequelize.col("available_qty")), "available_qty"],
      ],
      group: ["book_id"],
      raw: true,
    });

    const invMap = new Map(
      invRows.map((r) => [Number(r.book_id), Number(r.available_qty || 0)])
    );

    // ✅ Build: Class -> Books
    const classMap = new Map();

    for (const row of reqRows) {
      const book = row.book;
      if (!book) continue;

      const bookId = Number(book.id);
      const className = book.class_name || "Unknown";

      if (!classMap.has(className)) classMap.set(className, []);

      classMap.get(className).push({
        book_id: bookId,
        title: book.title,
        subject: book.subject || null,
        code: book.code || null,

        required_qty: Number(row.get("required_qty") || 0),
        available_qty: invMap.get(bookId) || 0,

        // ✅ future-proof (today 0)
        reserved_qty: 0,
        issued_qty: 0,
      });
    }

    const classes = Array.from(classMap.entries())
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([class_name, books]) => ({
        class_name,
        books: books.sort((x, y) =>
          (x.title || "").localeCompare(y.title || "")
        ),
      }));

    return reply.send({
      mode: "GLOBAL_AVAILABILITY",
      school,
      academic_session: academic_session || null,
      classes,
    });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ message: "Internal Server Error" });
  }
};
