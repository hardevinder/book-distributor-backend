// controllers/schoolBookRequirementController.js

"use strict";

const {
  SchoolBookRequirement,
  School,
  Supplier, // ✅ NEW
  Book,
  Publisher,
  Class,
  sequelize,
} = require("../models");
const { Op } = require("sequelize");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit"); // 🆕 for PDF printing

/* ===========================
 * Small helpers
 * =========================== */

const toInt = (v) => {
  if (v === "" || v === null || typeof v === "undefined") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const toStr = (v) => {
  if (v === "" || v === null || typeof v === "undefined") return null;
  return String(v);
};

const truthy = (v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") {
    const s = v.toLowerCase().trim();
    return ["1", "true", "yes", "y", "locked", "on"].includes(s);
  }
  return Boolean(v);
};

/**
 * GET /api/requirements
 * Supports (all optional):
 *  - q
 *  - schoolId / school_id
 *  - bookId / book_id
 *  - classId / class_id
 *  - class_name / className
 *  - supplierId / supplier_id
 *  - academic_session
 *  - status
 *  - publisherId / publisher_id
 *  - publisher / publisher_name
 *  - page, limit
 */
exports.getRequirements = async (request, reply) => {
  try {
    const query = request.query || {};

    // ---- accept aliases from frontend safely ----
    const q = query.q;

    const schoolId = query.schoolId ?? query.school_id;
    const bookId = query.bookId ?? query.book_id;
    const classId = query.classId ?? query.class_id;
    const supplierId = query.supplierId ?? query.supplier_id;

    const academic_session = query.academic_session;
    const status = query.status;

    // publisher aliases
    const publisherId =
      query.publisherId ?? query.publisher_id ?? query.book_publisher_id;
    const publisherName = query.publisher ?? query.publisher_name;

    // class aliases (name)
    const className = query.class_name ?? query.className;

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = {};

    if (schoolId) where.school_id = Number(schoolId);
    if (bookId) where.book_id = Number(bookId);
    if (supplierId) where.supplier_id = Number(supplierId);
    if (academic_session) where.academic_session = String(academic_session);
    if (status) where.status = String(status);

    // include graph
    const include = [
      {
        model: School,
        as: "school",
        attributes: ["id", "name"],
        required: true,
      },
      {
        model: Supplier,
        as: "supplier",
        attributes: ["id", "name"],
        required: false,
      },
      {
        model: Book,
        as: "book",
        attributes: ["id", "title", "publisher_id", "class_name"],
        required: true,
        include: [
          {
            model: Publisher,
            as: "publisher",
            attributes: ["id", "name"],
            required: false,
          },
        ],
      },
      {
        model: Class,
        as: "class",
        attributes: ["id", "class_name", "sort_order"],
        required: false,
      },
    ];

    // ---- CLASS FILTER (id OR name) ----
    if (classId) {
      where.class_id = Number(classId);
    } else if (className && String(className).trim()) {
      const cn = String(className).trim();

      // filter by joined Class table
      include[3].where = {
        ...(include[3].where || {}),
        class_name: { [Op.like]: `%${cn}%` },
      };
      include[3].required = true;

      // keep compatibility with records relying on book.class_name
      where[Op.or] = [
        ...(where[Op.or] || []),
        { "$class.class_name$": { [Op.like]: `%${cn}%` } },
        { "$book.class_name$": { [Op.like]: `%${cn}%` } },
      ];
    }

    // ---- PUBLISHER FILTER (id OR name) ----
    if (publisherId) {
      include[2].where = {
        ...(include[2].where || {}),
        publisher_id: Number(publisherId),
      };
      include[2].required = true;
    } else if (publisherName && String(publisherName).trim()) {
      const pn = String(publisherName).trim();
      include[2].include[0].where = {
        ...(include[2].include[0].where || {}),
        name: { [Op.like]: `%${pn}%` },
      };
      include[2].include[0].required = true;
      include[2].required = true;
    }

    // ---- TEXT SEARCH (q) across school + book title + publisher + supplier ----
    if (q && String(q).trim()) {
      const search = String(q).trim();

      // Make includes optional so OR can work (otherwise it becomes AND-like)
      include[0].required = false;
      include[2].required = false;
      include[2].include[0].required = false;
      include[1].required = false;
      include[3].required = false;

      where[Op.or] = [
        ...(where[Op.or] || []),
        { "$school.name$": { [Op.like]: `%${search}%` } },
        { "$book.title$": { [Op.like]: `%${search}%` } },
        { "$book->publisher.name$": { [Op.like]: `%${search}%` } },
        { "$supplier.name$": { [Op.like]: `%${search}%` } },
        { "$class.class_name$": { [Op.like]: `%${search}%` } },
      ];
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(limit, 10) || 20, 1);
    const offset = (pageNum - 1) * pageSize;

    const { rows, count } = await SchoolBookRequirement.findAndCountAll({
      where,
      include,
      order: [["id", "DESC"]],
      limit: pageSize,
      offset,
      distinct: true,
      subQuery: false, // makes "$school.name$" etc work reliably
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
    request.log.error({ err }, "Error in getRequirements");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to fetch requirements",
    });
  }
};

/**
 * GET /api/requirements/:id
 */
exports.getRequirementById = async (request, reply) => {
  try {
    const { id } = request.params;

    const requirement = await SchoolBookRequirement.findByPk(id, {
      include: [
        { model: School, as: "school", attributes: ["id", "name"] },
        {
          model: Supplier,
          as: "supplier",
          attributes: ["id", "name"],
          required: false,
        },
        {
          model: Book,
          as: "book",
          attributes: ["id", "title"],
          include: [
            {
              model: Publisher,
              as: "publisher",
              attributes: ["id", "name"],
            },
          ],
        },
        { model: Class, as: "class", attributes: ["id", "class_name"] },
      ],
    });

    if (!requirement) {
      return reply.code(404).send({ message: "Requirement not found" });
    }

    return reply.send(requirement);
  } catch (err) {
    request.log.error({ err }, "Error in getRequirementById");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to fetch requirement",
    });
  }
};

/**
 * POST /api/requirements
 * 👉 Upsert-style:
 *  - If (school_id, book_id, academic_session) not present → CREATE
 *  - If exists → UPDATE existing record with latest values
 */
exports.createRequirement = async (request, reply) => {
  const t = await sequelize.transaction();
  try {
    const {
      school_id,
      book_id,
      supplier_id, // ✅ NEW
      class_id,
      academic_session,
      required_copies = 0,
      status = "draft",
      remarks,
      is_locked = false,
    } = request.body || {};

    if (!school_id || !book_id) {
      await t.rollback();
      return reply.code(400).send({
        message: "school_id and book_id are required.",
      });
    }

    const school = await School.findByPk(school_id, { transaction: t });
    if (!school) {
      await t.rollback();
      return reply.code(400).send({ message: "Invalid school_id." });
    }

    const book = await Book.findByPk(book_id, { transaction: t });
    if (!book) {
      await t.rollback();
      return reply.code(400).send({ message: "Invalid book_id." });
    }

    if (supplier_id) {
      const sup = await Supplier.findByPk(supplier_id, { transaction: t });
      if (!sup) {
        await t.rollback();
        return reply.code(400).send({ message: "Invalid supplier_id." });
      }
    }

    let classObj = null;
    if (class_id) {
      classObj = await Class.findByPk(class_id, { transaction: t });
      if (!classObj) {
        await t.rollback();
        return reply.code(400).send({ message: "Invalid class_id." });
      }
    }

    const numericCopies = Number(required_copies) || 0;

    const [record, created] = await SchoolBookRequirement.findOrCreate({
      where: {
        school_id,
        book_id,
        academic_session: academic_session || null,
      },
      defaults: {
        supplier_id: supplier_id || null,
        class_id: classObj ? class_id : null,
        required_copies: numericCopies,
        status: status || "draft",
        remarks: remarks || null,
        is_locked: Boolean(is_locked),
      },
      transaction: t,
    });

    if (!created) {
      if (typeof supplier_id !== "undefined")
        record.supplier_id = supplier_id || null;

      // ⚠️ If frontend sends class_id but it doesn't exist, we force null to avoid FK garbage
      if (typeof class_id !== "undefined") record.class_id = classObj ? class_id : null;

      record.required_copies = numericCopies;
      if (typeof status !== "undefined") record.status = status || "draft";
      if (typeof remarks !== "undefined") record.remarks = remarks || null;
      if (typeof is_locked !== "undefined")
        record.is_locked = Boolean(is_locked);

      await record.save({ transaction: t });
    }

    await t.commit();

    const fullRequirement = await SchoolBookRequirement.findByPk(record.id, {
      include: [
        { model: School, as: "school", attributes: ["id", "name"] },
        {
          model: Supplier,
          as: "supplier",
          attributes: ["id", "name"],
          required: false,
        },
        {
          model: Book,
          as: "book",
          attributes: ["id", "title"],
          include: [{ model: Publisher, as: "publisher", attributes: ["id", "name"] }],
        },
        { model: Class, as: "class", attributes: ["id", "class_name"] },
      ],
    });

    return reply.code(created ? 201 : 200).send(fullRequirement);
  } catch (err) {
    await t.rollback();
    request.log.error({ err }, "Error in createRequirement");

    if (err.name === "SequelizeUniqueConstraintError") {
      return reply.code(400).send({
        error:
          "Requirement already exists for this School / Book / Session. Please edit it or change session/class.",
      });
    }

    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to create/update requirement",
    });
  }
};

/**
 * PUT /api/requirements/:id
 */
exports.updateRequirement = async (request, reply) => {
  const t = await sequelize.transaction();
  try {
    const { id } = request.params;

    const requirement = await SchoolBookRequirement.findByPk(id);
    if (!requirement) {
      await t.rollback();
      return reply.code(404).send({ message: "Requirement not found" });
    }

    const {
      school_id,
      book_id,
      supplier_id, // ✅ NEW
      class_id,
      academic_session,
      required_copies,
      status,
      remarks,
      is_locked,
    } = request.body || {};

    if (school_id) {
      const school = await School.findByPk(school_id, { transaction: t });
      if (!school) {
        await t.rollback();
        return reply.code(400).send({ message: "Invalid school_id." });
      }
      requirement.school_id = school_id;
    }

    if (book_id) {
      const book = await Book.findByPk(book_id, { transaction: t });
      if (!book) {
        await t.rollback();
        return reply.code(400).send({ message: "Invalid book_id." });
      }
      requirement.book_id = book_id;
    }

    if (typeof supplier_id !== "undefined") {
      if (supplier_id) {
        const sup = await Supplier.findByPk(supplier_id, { transaction: t });
        if (!sup) {
          await t.rollback();
          return reply.code(400).send({ message: "Invalid supplier_id." });
        }
        requirement.supplier_id = supplier_id;
      } else {
        requirement.supplier_id = null;
      }
    }

    if (typeof class_id !== "undefined") {
      if (class_id) {
        const cls = await Class.findByPk(class_id, { transaction: t });
        if (!cls) {
          await t.rollback();
          return reply.code(400).send({ message: "Invalid class_id." });
        }
        requirement.class_id = class_id;
      } else {
        requirement.class_id = null;
      }
    }

    if (typeof academic_session !== "undefined") {
      requirement.academic_session = academic_session || null;
    }

    if (typeof required_copies !== "undefined") {
      requirement.required_copies = Number(required_copies) || 0;
    }

    if (typeof status !== "undefined") requirement.status = status;
    if (typeof remarks !== "undefined") requirement.remarks = remarks || null;
    if (typeof is_locked !== "undefined")
      requirement.is_locked = Boolean(is_locked);

    await requirement.save({ transaction: t });
    await t.commit();

    const fullRequirement = await SchoolBookRequirement.findByPk(requirement.id, {
      include: [
        { model: School, as: "school", attributes: ["id", "name"] },
        {
          model: Supplier,
          as: "supplier",
          attributes: ["id", "name"],
          required: false,
        },
        {
          model: Book,
          as: "book",
          attributes: ["id", "title"],
          include: [{ model: Publisher, as: "publisher", attributes: ["id", "name"] }],
        },
        { model: Class, as: "class", attributes: ["id", "class_name"] },
      ],
    });

    return reply.send(fullRequirement);
  } catch (err) {
    await t.rollback();
    request.log.error({ err }, "Error in updateRequirement");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to update requirement",
    });
  }
};

/**
 * DELETE /api/requirements/:id
 */
exports.deleteRequirement = async (request, reply) => {
  const t = await sequelize.transaction();
  try {
    const { id } = request.params;

    const requirement = await SchoolBookRequirement.findByPk(id, { transaction: t });
    if (!requirement) {
      await t.rollback();
      return reply.code(404).send({ message: "Requirement not found" });
    }

    await requirement.destroy({ transaction: t });
    await t.commit();

    return reply.send({ message: "Requirement deleted successfully" });
  } catch (err) {
    await t.rollback();
    request.log.error({ err }, "Error in deleteRequirement");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to delete requirement",
    });
  }
};

/* ------------ BULK IMPORT: POST /api/requirements/import ------------ */
exports.importRequirements = async (request, reply) => {
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
    const rowNumber = index + 2;
    const t = await sequelize.transaction();
    try {
      const id = row.ID || row.Id || row.id || null;

      const schoolIdRaw =
        row["School ID"] || row.school_id || row.SchoolId || "";
      const schoolName =
        row["School Name"] || row.school || row.SchoolName || "";

      const bookIdRaw = row["Book ID"] || row.book_id || row.BookId || "";
      const bookTitle =
        row["Book Title"] || row.book || row.title || row.BookTitle || "";

      const supplierName =
        row["Supplier Name"] ||
        row.supplier ||
        row.supplier_name ||
        "";

      const className = row.Class || row["Class Name"] || row.class_name || "";
      const sessionRaw =
        row["Session"] ||
        row["Academic Session"] ||
        row.academic_session ||
        "";
      const copiesRaw =
        row["Required Copies"] || row.required_copies || row.Copies || "";

      const statusRaw = row.Status || row.status || "";
      const remarks = row.Remarks || row.remarks || "";
      const isLockedRaw =
        row["Is Locked"] || row.is_locked || row.IsLocked || false;

      // Resolve school
      let school_id = null;
      if (schoolIdRaw) {
        school_id = Number(schoolIdRaw);
      } else if (schoolName) {
        const school = await School.findOne({
          where: { name: String(schoolName).trim() },
          transaction: t,
        });
        if (!school) {
          errors.push({ row: rowNumber, error: `School "${schoolName}" not found.` });
          await t.rollback();
          continue;
        }
        school_id = school.id;
      }
      if (!school_id) {
        errors.push({ row: rowNumber, error: "School ID/Name is required." });
        await t.rollback();
        continue;
      }

      // Resolve book
      let book_id = null;
      if (bookIdRaw) {
        book_id = Number(bookIdRaw);
      } else if (bookTitle) {
        const book = await Book.findOne({
          where: { title: String(bookTitle).trim() },
          transaction: t,
        });
        if (!book) {
          errors.push({ row: rowNumber, error: `Book "${bookTitle}" not found.` });
          await t.rollback();
          continue;
        }
        book_id = book.id;
      }
      if (!book_id) {
        errors.push({ row: rowNumber, error: "Book ID/Title is required." });
        await t.rollback();
        continue;
      }

      // Resolve supplier (optional)
      let supplier_id = null;
      if (supplierName && String(supplierName).trim()) {
        const sup = await Supplier.findOne({
          where: { name: String(supplierName).trim() },
          transaction: t,
        });
        if (!sup) {
          errors.push({ row: rowNumber, error: `Supplier "${supplierName}" not found.` });
          await t.rollback();
          continue;
        }
        supplier_id = sup.id;
      }

      // Resolve class (optional)
      let class_id = null;
      if (className && String(className).trim()) {
        const cls = await Class.findOne({
          where: { class_name: String(className).trim() },
          transaction: t,
        });
        if (!cls) {
          errors.push({ row: rowNumber, error: `Class "${className}" not found.` });
          await t.rollback();
          continue;
        }
        class_id = cls.id;
      }

      const academic_session = sessionRaw ? String(sessionRaw).trim() : null;

      // required_copies
      let required_copies = 0;
      if (copiesRaw === "" || copiesRaw === null || typeof copiesRaw === "undefined") {
        required_copies = 0;
      } else if (Number.isNaN(Number(copiesRaw))) {
        errors.push({ row: rowNumber, error: "Required Copies must be numeric." });
        await t.rollback();
        continue;
      } else {
        required_copies = Number(copiesRaw);
      }

      // status
      let status = "draft";
      if (statusRaw) {
        const s = String(statusRaw).toLowerCase().trim();
        if (["draft", "confirmed"].includes(s)) status = s;
      }

      const is_locked = truthy(isLockedRaw);

      const payload = {
        school_id,
        book_id,
        supplier_id,
        class_id,
        academic_session,
        required_copies,
        status,
        remarks: remarks ? String(remarks) : null,
        is_locked,
      };

      // If ID present -> update that row if exists
      if (id) {
        const existing = await SchoolBookRequirement.findByPk(id, { transaction: t });
        if (existing) {
          await existing.update(payload, { transaction: t });
          updatedCount++;
          await t.commit();
          continue;
        }
      }

      // Otherwise -> create / upsert by (school_id, book_id, academic_session)
      const [rec, created] = await SchoolBookRequirement.findOrCreate({
        where: {
          school_id,
          book_id,
          academic_session: academic_session || null,
        },
        defaults: payload,
        transaction: t,
      });

      if (!created) {
        await rec.update(payload, { transaction: t });
        updatedCount++;
      } else {
        createdCount++;
      }

      await t.commit();
    } catch (err) {
      await t.rollback();
      errors.push({ row: rowNumber, error: err.message });
    }
  }

  return {
    message: "Requirements import completed",
    created: createdCount,
    updated: updatedCount,
    errors,
  };
};

/* ------------ BULK EXPORT: GET /api/requirements/export ------------ */
exports.exportRequirements = async (request, reply) => {
  try {
    const { schoolId, academic_session, status, publisherId } = request.query || {};

    const where = {};
    if (schoolId) where.school_id = Number(schoolId);
    if (academic_session) where.academic_session = String(academic_session);
    if (status) where.status = String(status);
    if (publisherId) where["$book.publisher_id$"] = Number(publisherId);

    // ---------- REF DATA ----------
    const schools = await School.findAll({
      where: { is_active: true },
      order: [["sort_order", "ASC"], ["name", "ASC"]],
    });

    const classes = await Class.findAll({
      where: { is_active: true },
      order: [["sort_order", "ASC"], ["class_name", "ASC"]],
    });

    const suppliers = await Supplier.findAll({
      attributes: ["id", "name"],
      order: [["name", "ASC"]],
    });

    const booksWhere = {};
    if (publisherId) booksWhere.publisher_id = Number(publisherId);

    const books = await Book.findAll({
      where: booksWhere,
      include: [{ model: Publisher, as: "publisher", attributes: ["id", "name"] }],
      order: [["class_name", "ASC"], ["subject", "ASC"], ["title", "ASC"]],
    });

    const requirements = await SchoolBookRequirement.findAll({
      where,
      include: [
        { model: School, as: "school", attributes: ["id", "name"] },
        { model: Supplier, as: "supplier", attributes: ["id", "name"], required: false },
        {
          model: Book,
          as: "book",
          attributes: ["id", "title", "publisher_id"],
          include: [{ model: Publisher, as: "publisher", attributes: ["id", "name"] }],
        },
        { model: Class, as: "class", attributes: ["id", "class_name"] },
      ],
      order: [
        [sequelize.literal("`school`.`name`"), "ASC"],
        [sequelize.literal("`class`.`sort_order`"), "ASC"],
        ["id", "ASC"],
      ],
    });

    const workbook = new ExcelJS.Workbook();

    // ---------- Sheet 1: Requirements ----------
    const reqSheet = workbook.addWorksheet("Requirements");

    reqSheet.columns = [
      { header: "ID", key: "id", width: 8 },
      { header: "School Name", key: "school_name", width: 35 },
      { header: "Book Title", key: "book_title", width: 40 },
      { header: "Supplier Name", key: "supplier_name", width: 28 },
      { header: "Publisher Name", key: "publisher_name", width: 30 },
      { header: "Class", key: "class_name", width: 20 },
      { header: "Session", key: "academic_session", width: 15 },
      { header: "Required Copies", key: "required_copies", width: 15 },
      { header: "Status", key: "status", width: 12 },
      { header: "Remarks", key: "remarks", width: 30 },
      { header: "Is Locked", key: "is_locked", width: 10 },
    ];

    reqSheet.getRow(1).font = { bold: true };
    reqSheet.getRow(1).alignment = { vertical: "middle", horizontal: "center" };

    requirements.forEach((r) => {
      reqSheet.addRow({
        id: r.id,
        school_name: r.school ? r.school.name : "",
        book_title: r.book ? r.book.title : "",
        supplier_name: r.supplier?.name || "",
        publisher_name: r.book?.publisher?.name || "",
        class_name: r.class ? r.class.class_name : "",
        academic_session: r.academic_session || "",
        required_copies: r.required_copies,
        status: r.status,
        remarks: r.remarks || "",
        is_locked: r.is_locked ? "TRUE" : "FALSE",
      });
    });

    reqSheet.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];

    // ---------- Sheet 2: Schools ----------
    const schoolsSheet = workbook.addWorksheet("Schools");
    schoolsSheet.getCell("A1").value = "School Name";
    schoolsSheet.getRow(1).font = { bold: true };
    schools.forEach((s, index) => {
      schoolsSheet.getCell(index + 2, 1).value = s.name;
    });
    const schoolRange =
      schools.length > 0
        ? `Schools!$A$2:$A$${schools.length + 1}`
        : `Schools!$A$2:$A$2`;

    // ---------- Sheet 3: Suppliers ----------
    const suppliersSheet = workbook.addWorksheet("Suppliers");
    suppliersSheet.getCell("A1").value = "Supplier Name";
    suppliersSheet.getRow(1).font = { bold: true };
    suppliers.forEach((s, idx) => {
      suppliersSheet.getCell(idx + 2, 1).value = s.name;
    });
    const supplierRange =
      suppliers.length > 0
        ? `Suppliers!$A$2:$A$${suppliers.length + 1}`
        : `Suppliers!$A$2:$A$2`;

    // ---------- Sheet 4: Books ----------
    const booksSheet = workbook.addWorksheet("Books");
    booksSheet.getRow(1).values = ["Book ID", "Book Title", "Publisher Name", "Class", "Subject"];
    booksSheet.getRow(1).font = { bold: true };
    books.forEach((b, index) => {
      booksSheet.getRow(index + 2).values = [
        b.id,
        b.title,
        b.publisher ? b.publisher.name : "",
        b.class_name || "",
        b.subject || "",
      ];
    });
    const bookTitleRange =
      books.length > 0 ? `Books!$B$2:$B$${books.length + 1}` : `Books!$B$2:$B$2`;
    const bookLookupRange =
      books.length > 0 ? `Books!$B$2:$C$${books.length + 1}` : `Books!$B$2:$C$2`;

    // ---------- Sheet 5: Classes ----------
    const classesSheet = workbook.addWorksheet("Classes");
    classesSheet.getCell("A1").value = "Class Name";
    classesSheet.getRow(1).font = { bold: true };
    classes.forEach((c, index) => {
      classesSheet.getCell(index + 2, 1).value = c.class_name;
    });
    const classRange =
      classes.length > 0
        ? `Classes!$A$2:$A$${classes.length + 1}`
        : `Classes!$A$2:$A$2`;

    // ---------- Session dropdown ----------
    const baseSessionStart = 2025;
    const sessionOptions = [];
    for (let i = 0; i <= 5; i++) {
      const y1 = baseSessionStart + i;
      const y2Short = String((y1 + 1) % 100).padStart(2, "0");
      sessionOptions.push(`${y1}-${y2Short}`);
    }
    const sessionFormula = `"${sessionOptions.join(",")}"`;

    // ---------- Validations + autofill Publisher only ----------
    const maxRows = Math.max(requirements.length + 50, 200);

    for (let row = 2; row <= maxRows; row++) {
      // School Name → col 2
      reqSheet.getCell(row, 2).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [schoolRange],
      };

      // Book Title → col 3
      reqSheet.getCell(row, 3).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [bookTitleRange],
      };

      // Supplier Name → col 4 (manual dropdown)
      reqSheet.getCell(row, 4).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [supplierRange],
      };

      // Publisher Name → col 5 auto from Book Title
      reqSheet.getCell(row, 5).value = {
        formula: `IFERROR(VLOOKUP($C${row},${bookLookupRange},2,FALSE),"")`,
      };

      // Class → col 6
      reqSheet.getCell(row, 6).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [classRange],
      };

      // Session → col 7
      reqSheet.getCell(row, 7).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [sessionFormula],
      };

      // Required Copies → col 8
      reqSheet.getCell(row, 8).dataValidation = {
        type: "whole",
        operator: "greaterThanOrEqual",
        allowBlank: true,
        formulae: [0],
      };
    }

    const buffer = await workbook.xlsx.writeBuffer();

    reply
      .header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      )
      .header(
        "Content-Disposition",
        'attachment; filename="school-book-requirements.xlsx"'
      )
      .send(Buffer.from(buffer));
  } catch (err) {
    request.log.error({ err }, "Error in exportRequirements");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to export requirements",
    });
  }
};

/* ------------ PDF EXPORT: GET /api/requirements/print-pdf ------------ */
exports.printRequirementsPdf = (request, reply) => {
  const { schoolId, academic_session, status, publisherId } = request.query || {};

  const where = {};
  if (schoolId) where.school_id = Number(schoolId);
  if (academic_session) where.academic_session = String(academic_session);
  if (status) where.status = String(status);
  if (publisherId) where["$book.publisher_id$"] = Number(publisherId);

  SchoolBookRequirement.findAll({
    where,
    include: [
      { model: School, as: "school", attributes: ["id", "name"] },
      { model: Supplier, as: "supplier", attributes: ["id", "name"], required: false },
      {
        model: Book,
        as: "book",
        attributes: ["id", "title", "publisher_id"],
        include: [{ model: Publisher, as: "publisher", attributes: ["id", "name"] }],
      },
      { model: Class, as: "class", attributes: ["id", "class_name", "sort_order"] },
    ],
    order: [
      [sequelize.literal("`school`.`name`"), "ASC"],
      [sequelize.literal("`class`.`sort_order`"), "ASC"],
      ["id", "ASC"],
    ],
  })
    .then((requirements) => {
      const groups = new Map();
      for (const r of requirements) {
        const sid = r.school ? r.school.id : 0;
        if (!groups.has(sid)) groups.set(sid, { school: r.school, items: [] });
        groups.get(sid).items.push(r);
      }

      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));

      doc.on("end", () => {
        const pdfBuffer = Buffer.concat(chunks);
        if (reply.sent) return;
        reply
          .header("Content-Type", "application/pdf")
          .header(
            "Content-Disposition",
            'attachment; filename="school-book-requirements.pdf"'
          )
          .send(pdfBuffer);
      });

      doc.on("error", (err) => {
        request.log.error({ err }, "PDF generation error");
        if (!reply.sent) {
          reply.code(500).send({
            error: "InternalServerError",
            message: "Failed to generate requirements PDF",
          });
        }
      });

      // ✅ Header (Session removed completely)
      const printHeader = (schoolName) => {
        const title = "School Book Requirements";
        const today = new Date();

        doc.font("Helvetica-Bold").fontSize(16).text(title, { align: "center" });
        doc.moveDown(0.25);

        doc
          .font("Helvetica-Bold")
          .fontSize(13)
          .text(schoolName || "All Schools", { align: "center" });

        const dateStr = today.toLocaleDateString("en-IN");
        doc.moveDown(0.2);
        doc.font("Helvetica").fontSize(9).text(`Date: ${dateStr}`, { align: "center" });

        // ❌ No Session line

        doc.moveDown(0.6);
        doc
          .moveTo(doc.page.margins.left, doc.y)
          .lineTo(doc.page.width - doc.page.margins.right, doc.y)
          .stroke();
        doc.moveDown(0.4);
      };

      const printClassHeading = (className) => {
        doc
          .font("Helvetica-Bold")
          .fontSize(12)
          .text(`Class: ${className || "-"}`, { align: "left" });
        doc.moveDown(0.3);
      };

      // ✅ Table header (Session column removed, Publisher width increased)
      const printTableHeader = (withClassCol) => {
        const y = doc.y;
        doc.font("Helvetica-Bold").fontSize(9);

        doc.text("Sr", 40, y, { width: 20 });

        if (withClassCol) doc.text("Class", 65, y, { width: 45 });

        doc.text("Book Title", withClassCol ? 115 : 65, y, {
          width: withClassCol ? 200 : 240,
        });

        doc.text("Publisher", withClassCol ? 325 : 305, y, { width: 170 });

        doc.text("Qty", 505, y, { width: 50, align: "right" });

        doc.moveDown(0.4);
        doc
          .moveTo(doc.page.margins.left, doc.y)
          .lineTo(doc.page.width - doc.page.margins.right, doc.y)
          .stroke();
        doc.moveDown(0.3);
      };

      const ensureSpaceForRow = (approxHeight = 16, schoolName, className, withClassCol) => {
        const bottom = doc.page.height - doc.page.margins.bottom;
        if (doc.y + approxHeight > bottom) {
          doc.addPage();
          printHeader(schoolName);
          if (className) printClassHeading(className);
          printTableHeader(withClassCol);
        }
      };

      if (!requirements.length) {
        printHeader(null);
        doc.font("Helvetica").fontSize(11).text("No requirements found.", { align: "left" });
        doc.end();
        return;
      }

      const groupEntries = Array.from(groups.values());

      groupEntries.forEach((group, idx) => {
        const schoolName = group.school?.name || "Unknown School";
        if (idx > 0) doc.addPage();

        // ✅ If single school download: each class on a new page
        if (schoolId) {
          const classMap = new Map();
          for (const r of group.items) {
            const key = r.class?.id || 0;
            if (!classMap.has(key)) {
              classMap.set(key, {
                className: r.class?.class_name || "-",
                sort: r.class?.sort_order ?? 9999,
                items: [],
              });
            }
            classMap.get(key).items.push(r);
          }

          const classesArr = Array.from(classMap.values()).sort((a, b) => {
            if (a.sort !== b.sort) return a.sort - b.sort;
            return String(a.className).localeCompare(String(b.className));
          });

          classesArr.forEach((clsGroup, cIdx) => {
            if (cIdx > 0) doc.addPage();

            printHeader(schoolName);
            printClassHeading(clsGroup.className);
            printTableHeader(false);

            let sr = 1;
            for (const r of clsGroup.items) {
              ensureSpaceForRow(18, schoolName, clsGroup.className, false);

              const y = doc.y;
              doc.font("Helvetica").fontSize(9);

              const bookTitle = r.book?.title || "-";
              const publisherName = r.book?.publisher?.name || "-";
              const qty = r.required_copies != null ? String(r.required_copies) : "0";

              doc.text(String(sr), 40, y, { width: 20 });
              doc.text(bookTitle, 65, y, { width: 240 });
              doc.text(publisherName, 305, y, { width: 170 });
              doc.text(qty, 505, y, { width: 50, align: "right" });

              doc.moveDown(0.7);
              sr++;
            }
          });

          return;
        }

        // ✅ All-schools mode
        printHeader(schoolName);
        printTableHeader(true);

        let sr = 1;
        for (const r of group.items) {
          ensureSpaceForRow(18, schoolName, null, true);

          const y = doc.y;
          doc.font("Helvetica").fontSize(9);

          const clsName = r.class?.class_name || "-";
          const bookTitle = r.book?.title || "-";
          const publisherName = r.book?.publisher?.name || "-";
          const qty = r.required_copies != null ? String(r.required_copies) : "0";

          doc.text(String(sr), 40, y, { width: 20 });
          doc.text(clsName, 65, y, { width: 45 });
          doc.text(bookTitle, 115, y, { width: 200 });
          doc.text(publisherName, 325, y, { width: 170 });
          doc.text(qty, 505, y, { width: 50, align: "right" });

          doc.moveDown(0.7);
          sr++;
        }
      });

      doc.end();
    })
    .catch((err) => {
      request.log.error({ err }, "Error in printRequirementsPdf");
      if (!reply.sent) {
        reply.code(500).send({
          error: "InternalServerError",
          message: err.message || "Failed to generate requirements PDF",
        });
      }
    });
};
