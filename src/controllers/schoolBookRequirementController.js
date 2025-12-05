// controllers/schoolBookRequirementController.js

const {
  SchoolBookRequirement,
  School,
  Book,
  Publisher,
  Class,
  sequelize,
} = require("../models");
const { Op } = require("sequelize");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");

/**
 * GET /api/requirements
 * Query params:
 *  - q: text search (school name / book title / publisher / class)
 *  - schoolId
 *  - bookId
 *  - classId
 *  - academic_session
 *  - status (draft / confirmed)
 *  - publisherId (filter by book.publisher_id)
 *  - page (default 1)
 *  - limit (default 20)
 */
exports.getRequirements = async (request, reply) => {
  try {
    const {
      q,
      schoolId,
      bookId,
      classId,
      academic_session,
      status,
      publisherId,
      page = 1,
      limit = 20,
    } = request.query || {};

    const where = {};

    if (schoolId) where.school_id = Number(schoolId);
    if (bookId) where.book_id = Number(bookId);
    if (classId) where.class_id = Number(classId);
    if (academic_session) where.academic_session = String(academic_session);
    if (status) where.status = String(status);

    const include = [
      {
        model: School,
        as: "school",
        attributes: ["id", "name"],
      },
      {
        model: Book,
        as: "book",
        attributes: ["id", "title", "publisher_id"],
        include: [
          {
            model: Publisher,
            as: "publisher",
            attributes: ["id", "name"],
          },
        ],
      },
      {
        model: Class,
        as: "class",
        attributes: ["id", "class_name", "sort_order"],
      },
    ];

    // 🔍 text search across school + book title
    if (q && String(q).trim()) {
      const search = String(q).trim();

      // school name
      include[0].where = {
        ...(include[0].where || {}),
        name: { [Op.like]: `%${search}%` },
      };
      include[0].required = false;

      // book title
      include[1].where = {
        ...(include[1].where || {}),
        title: { [Op.like]: `%${search}%` },
      };
      include[1].required = false;
    }

    // 🔹 Filter by publisher (via Book.publisher_id)
    if (publisherId) {
      include[1].where = {
        ...(include[1].where || {}),
        publisher_id: Number(publisherId),
      };
      include[1].required = true; // must match this publisher
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(limit, 10) || 20, 1);
    const offset = (pageNum - 1) * pageSize;

    const { rows, count } = await SchoolBookRequirement.findAndCountAll({
      where,
      include,
      order: [
        [sequelize.literal("`school`.`name`"), "ASC"],
        [sequelize.literal("`class`.`sort_order`"), "ASC"],
        ["id", "ASC"],
      ],
      limit: pageSize,
      offset,
      distinct: true,
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
          model: Book,
          as: "book",
          attributes: ["id", "title"],
          include: [
            { model: Publisher, as: "publisher", attributes: ["id", "name"] },
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
 */
exports.createRequirement = async (request, reply) => {
  const t = await sequelize.transaction();
  try {
    const {
      school_id,
      book_id,
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

    const school = await School.findByPk(school_id);
    if (!school) {
      await t.rollback();
      return reply.code(400).send({ message: "Invalid school_id." });
    }

    const book = await Book.findByPk(book_id);
    if (!book) {
      await t.rollback();
      return reply.code(400).send({ message: "Invalid book_id." });
    }

    let classObj = null;
    if (class_id) {
      classObj = await Class.findByPk(class_id);
      if (!classObj) {
        await t.rollback();
        return reply.code(400).send({ message: "Invalid class_id." });
      }
    }

    const requirement = await SchoolBookRequirement.create(
      {
        school_id,
        book_id,
        class_id: classObj ? class_id : null,
        academic_session: academic_session || null,
        required_copies: Number(required_copies) || 0,
        status: status || "draft",
        remarks: remarks || null,
        is_locked: Boolean(is_locked),
      },
      { transaction: t }
    );

    await t.commit();

    const fullRequirement = await SchoolBookRequirement.findByPk(
      requirement.id,
      {
        include: [
          { model: School, as: "school", attributes: ["id", "name"] },
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
      }
    );

    return reply.code(201).send(fullRequirement);
  } catch (err) {
    await t.rollback();
    request.log.error({ err }, "Error in createRequirement");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to create requirement",
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
      class_id,
      academic_session,
      required_copies,
      status,
      remarks,
      is_locked,
    } = request.body || {};

    // Validate school if changed
    if (school_id) {
      const school = await School.findByPk(school_id);
      if (!school) {
        await t.rollback();
        return reply.code(400).send({ message: "Invalid school_id." });
      }
      requirement.school_id = school_id;
    }

    // Validate book if changed
    if (book_id) {
      const book = await Book.findByPk(book_id);
      if (!book) {
        await t.rollback();
        return reply.code(400).send({ message: "Invalid book_id." });
      }
      requirement.book_id = book_id;
    }

    if (typeof class_id !== "undefined") {
      if (class_id) {
        const cls = await Class.findByPk(class_id);
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

    if (typeof status !== "undefined") {
      requirement.status = status;
    }

    if (typeof remarks !== "undefined") {
      requirement.remarks = remarks || null;
    }

    if (typeof is_locked !== "undefined") {
      requirement.is_locked = Boolean(is_locked);
    }

    await requirement.save({ transaction: t });
    await t.commit();

    const fullRequirement = await SchoolBookRequirement.findByPk(
      requirement.id,
      {
        include: [
          { model: School, as: "school", attributes: ["id", "name"] },
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
      }
    );

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

    const requirement = await SchoolBookRequirement.findByPk(id);
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
/**
 * Expected Excel columns (case-insensitive, flexible):
 *  - ID
 *  - School ID / SchoolId (optional now)
 *  - School Name
 *  - Book ID / BookId (optional now)
 *  - Book Title
 *  - Class / Class Name
 *  - Session / Academic Session
 *  - Required Copies
 *  - Status
 *  - Remarks
 *  - Is Locked
 */
exports.importRequirements = async (request, reply) => {
  const file = await request.file();

  if (!file) {
    reply.code(400);
    return { error: "No file uploaded. Please upload an Excel file." };
  }

  const chunks = [];
  for await (const chunk of file.file) {
    chunks.push(chunk);
  }
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
    const rowNumber = index + 2; // header at row 1
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

      const className =
        row.Class || row["Class Name"] || row.class_name || "";

      const sessionRaw =
        row["Session"] || row["Academic Session"] || row.academic_session || "";

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
          where: { name: schoolName },
        });
        if (!school) {
          errors.push({
            row: rowNumber,
            error: `School "${schoolName}" not found.`,
          });
          await t.rollback();
          continue;
        }
        school_id = school.id;
      }

      if (!school_id) {
        errors.push({
          row: rowNumber,
          error: "School ID/Name is required.",
        });
        await t.rollback();
        continue;
      }

      // Resolve book
      let book_id = null;
      if (bookIdRaw) {
        book_id = Number(bookIdRaw);
      } else if (bookTitle) {
        const book = await Book.findOne({
          where: { title: bookTitle },
        });
        if (!book) {
          errors.push({
            row: rowNumber,
            error: `Book "${bookTitle}" not found.`,
          });
          await t.rollback();
          continue;
        }
        book_id = book.id;
      }

      if (!book_id) {
        errors.push({
          row: rowNumber,
          error: "Book ID/Title is required.",
        });
        await t.rollback();
        continue;
      }

      // Resolve class
      let class_id = null;
      if (className) {
        const cls = await Class.findOne({
          where: { class_name: className },
        });
        if (!cls) {
          errors.push({
            row: rowNumber,
            error: `Class "${className}" not found.`,
          });
          await t.rollback();
          continue;
        }
        class_id = cls.id;
      }

      const academic_session = sessionRaw || null;

      // 🔒 Required Copies must be numeric
      let required_copies = 0;
      if (
        copiesRaw === "" ||
        copiesRaw === null ||
        typeof copiesRaw === "undefined"
      ) {
        required_copies = 0;
      } else if (isNaN(Number(copiesRaw))) {
        errors.push({
          row: rowNumber,
          error: 'Required Copies must be numeric.',
        });
        await t.rollback();
        continue;
      } else {
        required_copies = Number(copiesRaw);
      }

      let status = "draft";
      if (statusRaw) {
        const s = String(statusRaw).toLowerCase().trim();
        if (["draft", "confirmed"].includes(s)) {
          status = s;
        }
      }

      const is_locked =
        typeof isLockedRaw === "string"
          ? ["1", "true", "yes", "locked"].includes(
              isLockedRaw.toLowerCase().trim()
            )
          : Boolean(isLockedRaw);

      const payload = {
        school_id,
        book_id,
        class_id,
        academic_session,
        required_copies,
        status,
        remarks: remarks || null,
        is_locked,
      };

      if (id) {
        const existing = await SchoolBookRequirement.findByPk(id);
        if (existing) {
          await existing.update(payload, { transaction: t });
          updatedCount++;
          await t.commit();
          continue;
        }
      }

      await SchoolBookRequirement.create(payload, { transaction: t });
      createdCount++;
      await t.commit();
    } catch (err) {
      await t.rollback();
      errors.push({
        row: rowNumber,
        error: err.message,
      });
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
/**
 * Excel:
 *  - School ID & Book ID columns removed.
 *  - Publisher auto from Book Title (VLOOKUP).
 *  - Session dropdown list: 2025-26 (first in list) + next 5 sessions.
 *  - Required Copies: numeric-only (whole number, >= 0).
 */
exports.exportRequirements = async (request, reply) => {
  try {
    const { schoolId, academic_session, status, publisherId } =
      request.query || {};

    const where = {};
    if (schoolId) where.school_id = Number(schoolId);
    if (academic_session) where.academic_session = String(academic_session);
    if (status) where.status = String(status);

    if (publisherId) {
      where["$book.publisher_id$"] = Number(publisherId);
    }

    // ---------- REF DATA ----------
    const schools = await School.findAll({
      where: { is_active: true },
      order: [
        ["sort_order", "ASC"],
        ["name", "ASC"],
      ],
    });

    const classes = await Class.findAll({
      where: { is_active: true },
      order: [
        ["sort_order", "ASC"],
        ["class_name", "ASC"],
      ],
    });

    const booksWhere = {};
    if (publisherId) {
      booksWhere.publisher_id = Number(publisherId);
    }

    const books = await Book.findAll({
      where: booksWhere,
      include: [
        { model: Publisher, as: "publisher", attributes: ["id", "name"] },
      ],
      order: [
        ["class_name", "ASC"],
        ["subject", "ASC"],
        ["title", "ASC"],
      ],
    });

    const requirements = await SchoolBookRequirement.findAll({
      where,
      include: [
        { model: School, as: "school", attributes: ["id", "name"] },
        {
          model: Book,
          as: "book",
          attributes: ["id", "title", "publisher_id"],
          include: [
            { model: Publisher, as: "publisher", attributes: ["id", "name"] },
          ],
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

    // NOTE: School ID & Book ID removed
    reqSheet.columns = [
      { header: "ID", key: "id", width: 8 }, // DB auto if blank for new rows
      { header: "School Name", key: "school_name", width: 35 },
      { header: "Book Title", key: "book_title", width: 40 },
      { header: "Publisher Name", key: "publisher_name", width: 30 },
      { header: "Class", key: "class_name", width: 20 },
      { header: "Session", key: "academic_session", width: 15 },
      { header: "Required Copies", key: "required_copies", width: 15 },
      { header: "Status", key: "status", width: 12 },
      { header: "Remarks", key: "remarks", width: 30 },
      { header: "Is Locked", key: "is_locked", width: 10 },
    ];

    reqSheet.getRow(1).font = { bold: true };
    reqSheet.getRow(1).alignment = {
      vertical: "middle",
      horizontal: "center",
    };

    requirements.forEach((r) => {
      reqSheet.addRow({
        id: r.id,
        school_name: r.school ? r.school.name : "",
        book_title: r.book ? r.book.title : "",
        publisher_name:
          r.book && r.book.publisher ? r.book.publisher.name : "",
        class_name: r.class ? r.class.class_name : "",
        // don't force-fill session; keep existing or blank
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

    const schoolListStartRow = 2;
    const schoolListEndRow = schools.length + 1;
    const schoolRange = `Schools!$A$${schoolListStartRow}:$A$${schoolListEndRow}`;

    // ---------- Sheet 3: Books ----------
    const booksSheet = workbook.addWorksheet("Books");
    booksSheet.getRow(1).values = [
      "Book ID",
      "Book Title",
      "Publisher Name",
      "Class",
      "Subject",
    ];
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

    const bookTitleStartRow = 2;
    const bookTitleEndRow = books.length + 1;
    const bookTitleRange = `Books!$B$${bookTitleStartRow}:$B$${bookTitleEndRow}`;
    const bookLookupRange = `Books!$B$${bookTitleStartRow}:$C$${bookTitleEndRow}`; // B:Title, C:Publisher

    // ---------- Sheet 4: Classes ----------
    const classesSheet = workbook.addWorksheet("Classes");
    classesSheet.getCell("A1").value = "Class Name";
    classesSheet.getRow(1).font = { bold: true };

    classes.forEach((c, index) => {
      classesSheet.getCell(index + 2, 1).value = c.class_name;
    });

    const classListStartRow = 2;
    const classListEndRow = classes.length + 1;
    const classRange = `Classes!$A$${classListStartRow}:$A$${classListEndRow}`;

    // ---------- Session dropdown values ----------
    // 2025-26 (default in list) + next 5: 2026-27 ... 2030-31
    const baseSessionStart = 2025; // 2025-26
    const sessionOptions = [];
    for (let i = 0; i <= 5; i++) {
      const y1 = baseSessionStart + i;
      const y2Short = String((y1 + 1) % 100).padStart(2, "0");
      // e.g. 2025-26, 2026-27
      sessionOptions.push(`${y1}-${y2Short}`);
    }
    const sessionFormula = `"${sessionOptions.join(",")}"`;

    // ---------- Apply dropdown validations + auto publisher + numeric copies ----------
    const maxRows = Math.max(requirements.length + 50, 200);

    for (let row = 2; row <= maxRows; row++) {
      // School Name → column 2
      const schoolCell = reqSheet.getCell(row, 2);
      schoolCell.dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [schoolRange],
        showErrorMessage: true,
        errorStyle: "error",
        errorTitle: "Invalid School",
        error: "Please select a school from the dropdown list (Schools sheet).",
      };

      // Book Title → column 3
      const bookCell = reqSheet.getCell(row, 3);
      bookCell.dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [bookTitleRange],
        showErrorMessage: true,
        errorStyle: "error",
        errorTitle: "Invalid Book",
        error: "Please select a book from the dropdown list (Books sheet).",
      };

      // 👉 Publisher Name auto from Book Title → column 4
      const publisherCell = reqSheet.getCell(row, 4);
      publisherCell.value = {
        formula: `IFERROR(VLOOKUP($C${row},${bookLookupRange},2,FALSE),"")`,
      };

      // Class → column 5
      const classCell = reqSheet.getCell(row, 5);
      classCell.dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [classRange],
        showErrorMessage: true,
        errorStyle: "error",
        errorTitle: "Invalid Class",
        error: "Please select a class from the dropdown list (Classes sheet).",
      };

      // Session → column 6 (dropdown only, no pre-fill from backend)
      const sessionCell = reqSheet.getCell(row, 6);
      sessionCell.dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [sessionFormula],
        showErrorMessage: true,
        errorStyle: "error",
        errorTitle: "Invalid Session",
        error: "Please select a session from the dropdown list.",
      };

      // 🔒 Required Copies → column 7 must be numeric (whole number >= 0)
      const copiesCell = reqSheet.getCell(row, 7);
      copiesCell.dataValidation = {
        type: "whole",
        operator: "greaterThanOrEqual",
        allowBlank: true,
        formulae: [0],
        showErrorMessage: true,
        errorStyle: "error",
        errorTitle: "Invalid Required Copies",
        error:
          "Required Copies must be a numeric value (whole number 0 or more).",
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
