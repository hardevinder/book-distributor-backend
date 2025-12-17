// controllers/bookController.js

const { Book, Publisher, Supplier, Class, sequelize } = require("../models");
const { Op } = require("sequelize");
const XLSX = require("xlsx"); // ⭐ for Excel import/export (import)
const ExcelJS = require("exceljs"); // ⭐ for Excel export with dropdown

/* ---------------- Helpers ---------------- */

function toNumberOrNull(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeBool(v, defaultVal = true) {
  if (typeof v === "undefined" || v === null || v === "") return defaultVal;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase().trim();
  return !["0", "false", "no", "inactive"].includes(s);
}

// auto-calc rate from mrp & discount%
function calcRateFromMrp(mrp, discount_percent) {
  const m = toNumberOrNull(mrp);
  const d = toNumberOrNull(discount_percent);
  if (m === null || d === null) return null;
  const rate = m - (m * d) / 100;
  // keep 2 decimals
  return Math.round(rate * 100) / 100;
}

/**
 * GET /api/books
 * Query params:
 *  - q: search text (title / code / subject / isbn)
 *  - publisherId
 *  - supplierId ✅
 *  - className
 *  - is_active (true/false)
 *  - page (default 1)
 *  - limit (default 20)
 */
exports.getBooks = async (request, reply) => {
  try {
    const {
      q,
      publisherId,
      supplierId,
      className,
      is_active,
      page = 1,
      limit = 20,
    } = request.query || {};

    const where = {};

    // 🔍 Text search
    if (q && String(q).trim()) {
      const search = String(q).trim();
      where[Op.or] = [
        { title: { [Op.like]: `%${search}%` } },
        { code: { [Op.like]: `%${search}%` } },
        { subject: { [Op.like]: `%${search}%` } },
        { isbn: { [Op.like]: `%${search}%` } },
      ];
    }

    // Filter by publisher
    if (publisherId) where.publisher_id = Number(publisherId);

    // ✅ Filter by supplier
    if (supplierId) where.supplier_id = Number(supplierId);

    // Filter by class
    if (className) where.class_name = className;

    // Filter by active status
    if (typeof is_active !== "undefined") {
      if (is_active === "true" || is_active === "1") where.is_active = true;
      if (is_active === "false" || is_active === "0") where.is_active = false;
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(limit, 10) || 20, 1);
    const offset = (pageNum - 1) * pageSize;

    const { rows, count } = await Book.findAndCountAll({
      where,
      include: [
        { model: Publisher, as: "publisher", attributes: ["id", "name"] },
        { model: Supplier, as: "supplier", attributes: ["id", "name"] },
      ],
      order: [
        ["class_name", "ASC"],
        ["subject", "ASC"],
        ["title", "ASC"],
      ],
      limit: pageSize,
      offset,
    });

    return reply.send({
      data: rows,
      meta: {
        total: count,
        page: pageNum,
        limit: pageSize,
        totalPages: Math.ceil(count / pageSize),
      },
    });
  } catch (err) {
    request.log.error({ err }, "Error in getBooks");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to fetch books",
    });
  }
};

/**
 * GET /api/books/:id
 */
exports.getBookById = async (request, reply) => {
  try {
    const { id } = request.params;

    const book = await Book.findByPk(id, {
      include: [
        { model: Publisher, as: "publisher", attributes: ["id", "name"] },
        { model: Supplier, as: "supplier", attributes: ["id", "name"] },
      ],
    });

    if (!book) return reply.code(404).send({ message: "Book not found" });

    return reply.send(book);
  } catch (err) {
    request.log.error({ err }, "Error in getBookById");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to fetch book",
    });
  }
};

/**
 * POST /api/books
 */
exports.createBook = async (request, reply) => {
  const t = await sequelize.transaction();
  try {
    const {
      title,
      code,
      isbn,
      publisher_id,
      supplier_id, // ✅ NEW
      class_name,
      subject,
      medium,
      mrp,
      discount_percent, // ✅ NEW
      rate, // ✅ NEW
      selling_price,
      is_active = true,
    } = request.body || {};

    if (!title || !publisher_id) {
      await t.rollback();
      return reply.code(400).send({
        message: "Title and publisher_id are required.",
      });
    }

    // Make sure publisher exists
    const publisher = await Publisher.findByPk(publisher_id);
    if (!publisher) {
      await t.rollback();
      return reply.code(400).send({ message: "Invalid publisher_id." });
    }

    // ✅ Validate supplier if provided
    let supplierIdToSave = null;
    if (
      typeof supplier_id !== "undefined" &&
      supplier_id !== null &&
      supplier_id !== "" &&
      supplier_id !== 0 &&
      supplier_id !== "0"
    ) {
      const supplier = await Supplier.findByPk(Number(supplier_id));
      if (!supplier) {
        await t.rollback();
        return reply.code(400).send({ message: "Invalid supplier_id." });
      }
      supplierIdToSave = Number(supplier_id);
    }

    const mrpVal = mrp ?? null;
    const discountVal = discount_percent ?? null;

    // ✅ Auto-calc rate if missing
    const rateVal =
      typeof rate !== "undefined" && rate !== null && rate !== ""
        ? rate
        : calcRateFromMrp(mrpVal, discountVal);

    const book = await Book.create(
      {
        title: title.trim(),
        code: code ? code.trim() : null,
        isbn: isbn ? isbn.trim() : null,
        publisher_id,
        supplier_id: supplierIdToSave,
        class_name: class_name ? class_name.trim() : null,
        subject: subject ? subject.trim() : null,
        medium: medium ? medium.trim() : null,
        mrp: mrpVal,
        discount_percent: discountVal,
        rate: rateVal,
        selling_price: selling_price ?? null,
        is_active: Boolean(is_active),
      },
      { transaction: t }
    );

    await t.commit();

    const fullBook = await Book.findByPk(book.id, {
      include: [
        { model: Publisher, as: "publisher", attributes: ["id", "name"] },
        { model: Supplier, as: "supplier", attributes: ["id", "name"] },
      ],
    });

    return reply.code(201).send(fullBook);
  } catch (err) {
    await t.rollback();
    request.log.error({ err }, "Error in createBook");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to create book",
    });
  }
};

/**
 * PUT /api/books/:id
 */
exports.updateBook = async (request, reply) => {
  const t = await sequelize.transaction();
  try {
    const { id } = request.params;

    const book = await Book.findByPk(id);
    if (!book) {
      await t.rollback();
      return reply.code(404).send({ message: "Book not found" });
    }

    const {
      title,
      code,
      isbn,
      publisher_id,
      supplier_id, // ✅ NEW
      class_name,
      subject,
      medium,
      mrp,
      discount_percent, // ✅ NEW
      rate, // ✅ NEW
      selling_price,
      is_active,
    } = request.body || {};

    // Validate publisher if changed
    if (publisher_id) {
      const publisher = await Publisher.findByPk(publisher_id);
      if (!publisher) {
        await t.rollback();
        return reply.code(400).send({ message: "Invalid publisher_id." });
      }
      book.publisher_id = publisher_id;
    }

    // ✅ Validate & set supplier_id if provided
    if (typeof supplier_id !== "undefined") {
      if (
        supplier_id === null ||
        supplier_id === "" ||
        supplier_id === 0 ||
        supplier_id === "0"
      ) {
        book.supplier_id = null;
      } else {
        const supplier = await Supplier.findByPk(Number(supplier_id));
        if (!supplier) {
          await t.rollback();
          return reply.code(400).send({ message: "Invalid supplier_id." });
        }
        book.supplier_id = Number(supplier_id);
      }
    }

    if (typeof title !== "undefined") book.title = title ? title.trim() : "";
    if (typeof code !== "undefined") book.code = code ? code.trim() : null;
    if (typeof isbn !== "undefined") book.isbn = isbn ? isbn.trim() : null;
    if (typeof class_name !== "undefined")
      book.class_name = class_name ? class_name.trim() : null;
    if (typeof subject !== "undefined")
      book.subject = subject ? subject.trim() : null;
    if (typeof medium !== "undefined")
      book.medium = medium ? medium.trim() : null;

    if (typeof mrp !== "undefined") book.mrp = mrp;
    if (typeof discount_percent !== "undefined")
      book.discount_percent = discount_percent;

    if (typeof rate !== "undefined") {
      book.rate = rate;
    } else {
      // ✅ if rate not sent, but mrp/discount changed, auto-calc when possible
      const auto = calcRateFromMrp(book.mrp, book.discount_percent);
      if (auto !== null) book.rate = auto;
    }

    if (typeof selling_price !== "undefined") book.selling_price = selling_price;
    if (typeof is_active !== "undefined") book.is_active = Boolean(is_active);

    await book.save({ transaction: t });
    await t.commit();

    const fullBook = await Book.findByPk(book.id, {
      include: [
        { model: Publisher, as: "publisher", attributes: ["id", "name"] },
        { model: Supplier, as: "supplier", attributes: ["id", "name"] },
      ],
    });

    return reply.send(fullBook);
  } catch (err) {
    await t.rollback();
    request.log.error({ err }, "Error in updateBook");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to update book",
    });
  }
};

/**
 * DELETE /api/books/:id
 */
exports.deleteBook = async (request, reply) => {
  const t = await sequelize.transaction();
  try {
    const { id } = request.params;

    const book = await Book.findByPk(id);
    if (!book) {
      await t.rollback();
      return reply.code(404).send({ message: "Book not found" });
    }

    await book.destroy({ transaction: t });
    await t.commit();

    return reply.send({ message: "Book deleted successfully" });
  } catch (err) {
    await t.rollback();
    request.log.error({ err }, "Error in deleteBook");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to delete book",
    });
  }
};

/* ------------ BULK IMPORT: POST /api/books/import ------------ */
exports.importBooks = async (request, reply) => {
  const file = await request.file();

  if (!file) {
    reply.code(400);
    return { error: "No file uploaded. Please upload an Excel file." };
  }

  const chunks = [];
  for await (const chunk of file.file) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer" });
  } catch (err) {
    request.log.error({ err }, "Failed to parse Excel file");
    reply.code(400);
    return { error: "Invalid Excel file" };
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  let createdCount = 0;
  let updatedCount = 0;
  const errors = [];

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2; // header assumed at row 1
    try {
      const id = row.ID || row.Id || row.id || null;

      const title = row.Title || row.title || "";
      const code = row.Code || row.code || "";
      const isbn = row.ISBN || row.isbn || "";
      const class_name = row.Class || row.class_name || "";
      const subject = row.Subject || row.subject || "";
      const medium = row.Medium || row.medium || "";

      const publisherIdRaw =
        row["Publisher ID"] || row.publisher_id || row.PublisherId || "";
      const publisherName =
        row["Publisher Name"] || row.publisher || row.PublisherName || "";

      // ✅ Supplier
      const supplierIdRaw =
        row["Supplier ID"] || row.supplier_id || row.SupplierId || "";
      const supplierName =
        row["Supplier Name"] || row.supplier || row.SupplierName || "";

      const mrpRaw = row.MRP || row.mrp || "";
      const discountRaw =
        row["Discount %"] || row.discount_percent || row.DiscountPercent || "";
      const rateRaw = row.Rate || row.rate || row["Unit Price"] || "";

      const sellingPriceRaw =
        row["Selling Price"] || row.selling_price || row.SellingPrice || "";

      const isActiveRaw =
        row["Is Active"] || row.is_active || row.IsActive || true;

      if (!title) continue;

      // 🔗 resolve publisher (ID preferred, else Name)
      let publisher_id = null;
      if (publisherIdRaw) {
        publisher_id = Number(publisherIdRaw);
      } else if (publisherName) {
        const publisher = await Publisher.findOne({
          where: { name: publisherName },
        });
        if (!publisher) {
          errors.push({
            row: rowNumber,
            error: `Publisher "${publisherName}" not found.`,
          });
          continue;
        }
        publisher_id = publisher.id;
      }

      if (!publisher_id) {
        errors.push({
          row: rowNumber,
          error: "Publisher ID/Name is required for each book.",
        });
        continue;
      }

      // ✅ resolve supplier (optional)
      let supplier_id = null;
      if (supplierIdRaw) {
        supplier_id = Number(supplierIdRaw);
        const s = await Supplier.findByPk(supplier_id);
        if (!s) {
          errors.push({
            row: rowNumber,
            error: `Invalid supplier_id "${supplier_id}".`,
          });
          continue;
        }
      } else if (supplierName) {
        const s = await Supplier.findOne({ where: { name: supplierName } });
        if (!s) {
          errors.push({
            row: rowNumber,
            error: `Supplier "${supplierName}" not found.`,
          });
          continue;
        }
        supplier_id = s.id;
      }

      const is_active = normalizeBool(isActiveRaw, true);

      const mrp = toNumberOrNull(mrpRaw);
      const discount_percent = toNumberOrNull(discountRaw);
      const selling_price = toNumberOrNull(sellingPriceRaw);

      // ✅ rate: take from file if present else auto-calc if possible
      let rate = toNumberOrNull(rateRaw);
      if (rate === null) {
        const auto = calcRateFromMrp(mrp, discount_percent);
        if (auto !== null) rate = auto;
      }

      const payload = {
        title,
        code: code || null,
        isbn: isbn || null,
        publisher_id,
        supplier_id,
        class_name: class_name || null,
        subject: subject || null,
        medium: medium || null,
        mrp,
        discount_percent,
        rate,
        selling_price,
        is_active,
      };

      if (id) {
        const existing = await Book.findByPk(id);
        if (existing) {
          await existing.update(payload);
          updatedCount++;
          continue;
        }
      }

      await Book.create(payload);
      createdCount++;
    } catch (err) {
      errors.push({ row: rowNumber, error: err.message });
    }
  }

  return {
    message: "Books import completed",
    created: createdCount,
    updated: updatedCount,
    errors,
  };
};

/* ------------ BULK EXPORT: GET /api/books/export ------------ */
exports.exportBooks = async (request, reply) => {
  try {
    const publishers = await Publisher.findAll({ order: [["name", "ASC"]] });
    const suppliers = await Supplier.findAll({ order: [["name", "ASC"]] });

    const classes = await Class.findAll({
      where: { is_active: true },
      order: [
        ["sort_order", "ASC"],
        ["class_name", "ASC"],
      ],
    });

    const books = await Book.findAll({
      include: [
        { model: Publisher, as: "publisher", attributes: ["id", "name"] },
        { model: Supplier, as: "supplier", attributes: ["id", "name"] },
      ],
      order: [["id", "ASC"]],
    });

    const workbook = new ExcelJS.Workbook();

    // Sheet 1: Books
    const booksSheet = workbook.addWorksheet("Books");

    // Column Order (IMPORTANT for dropdown index):
    // 1 ID
    // 2 Title
    // 3 Code
    // 4 ISBN
    // 5 Class
    // 6 Subject
    // 7 Medium
    // 8 Publisher ID
    // 9 Publisher Name  (dropdown)
    // 10 Supplier ID
    // 11 Supplier Name  (dropdown)
    // 12 MRP
    // 13 Discount %
    // 14 Rate
    // 15 Selling Price
    // 16 Is Active
    booksSheet.columns = [
      { header: "ID", key: "id", width: 8 },
      { header: "Title", key: "title", width: 40 },
      { header: "Code", key: "code", width: 15 },
      { header: "ISBN", key: "isbn", width: 20 },
      { header: "Class", key: "class_name", width: 20 },
      { header: "Subject", key: "subject", width: 20 },
      { header: "Medium", key: "medium", width: 12 },
      { header: "Publisher ID", key: "publisher_id", width: 12 },
      { header: "Publisher Name", key: "publisher_name", width: 30 },
      { header: "Supplier ID", key: "supplier_id", width: 12 },
      { header: "Supplier Name", key: "supplier_name", width: 30 },
      { header: "MRP", key: "mrp", width: 10 },
      { header: "Discount %", key: "discount_percent", width: 12 },
      { header: "Rate", key: "rate", width: 12 },
      { header: "Selling Price", key: "selling_price", width: 12 },
      { header: "Is Active", key: "is_active", width: 10 },
    ];

    // Header styling
    booksSheet.getRow(1).font = { bold: true };
    booksSheet.getRow(1).alignment = { vertical: "middle", horizontal: "center" };

    books.forEach((b) => {
      booksSheet.addRow({
        id: b.id,
        title: b.title,
        code: b.code,
        isbn: b.isbn,
        class_name: b.class_name,
        subject: b.subject,
        medium: b.medium,
        publisher_id: b.publisher_id,
        publisher_name: b.publisher ? b.publisher.name : "",
        supplier_id: b.supplier_id,
        supplier_name: b.supplier ? b.supplier.name : "",
        mrp: b.mrp,
        discount_percent: b.discount_percent,
        rate: b.rate,
        selling_price: b.selling_price,
        is_active: b.is_active ? "TRUE" : "FALSE",
      });
    });

    booksSheet.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];

    // Sheet 2: Publishers
    const publishersSheet = workbook.addWorksheet("Publishers");
    publishersSheet.getCell("A1").value = "Publisher Name";
    publishersSheet.getRow(1).font = { bold: true };
    publishers.forEach((p, index) => {
      publishersSheet.getCell(index + 2, 1).value = p.name;
    });
    const publisherRange = `Publishers!$A$2:$A$${publishers.length + 1}`;

    // Sheet 3: Suppliers
    const suppliersSheet = workbook.addWorksheet("Suppliers");
    suppliersSheet.getCell("A1").value = "Supplier Name";
    suppliersSheet.getRow(1).font = { bold: true };
    suppliers.forEach((s, index) => {
      suppliersSheet.getCell(index + 2, 1).value = s.name;
    });
    const supplierRange = `Suppliers!$A$2:$A$${suppliers.length + 1}`;

    // Sheet 4: Classes
    const classesSheet = workbook.addWorksheet("Classes");
    classesSheet.getCell("A1").value = "Class Name";
    classesSheet.getRow(1).font = { bold: true };
    classes.forEach((c, index) => {
      classesSheet.getCell(index + 2, 1).value = c.class_name;
    });
    const classRange = `Classes!$A$2:$A$${classes.length + 1}`;

    // Apply dropdowns
    const maxRows = Math.max(books.length + 50, 200);

    for (let row = 2; row <= maxRows; row++) {
      // Publisher Name dropdown → column 9
      const publisherCell = booksSheet.getCell(row, 9);
      publisherCell.dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [publisherRange],
        showErrorMessage: true,
        errorStyle: "error",
        errorTitle: "Invalid Publisher",
        error: "Please select a publisher from the dropdown list (Publishers sheet).",
      };

      // Supplier Name dropdown → column 11
      const supplierCell = booksSheet.getCell(row, 11);
      supplierCell.dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [supplierRange],
        showErrorMessage: true,
        errorStyle: "error",
        errorTitle: "Invalid Supplier",
        error: "Please select a supplier from the dropdown list (Suppliers sheet).",
      };

      // Class dropdown → column 5
      const classCell = booksSheet.getCell(row, 5);
      classCell.dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [classRange],
        showErrorMessage: true,
        errorStyle: "error",
        errorTitle: "Invalid Class",
        error: "Please select a class from the dropdown list (Classes sheet).",
      };
    }

    const buffer = await workbook.xlsx.writeBuffer();

    reply
      .header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      )
      .header("Content-Disposition", 'attachment; filename="books.xlsx"')
      .send(Buffer.from(buffer));
  } catch (err) {
    request.log.error({ err }, "Error in exportBooks");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to export books",
    });
  }
};
