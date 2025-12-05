// controllers/classController.js

const { Class, sequelize } = require("../models");
const { Op } = require("sequelize");
const XLSX = require("xlsx"); // ⭐ for Excel import
const ExcelJS = require("exceljs"); // ⭐ for Excel export

/**
 * GET /api/classes
 * Query params:
 *  - q: search text (class_name)
 *  - is_active (true/false)
 *  - page (default 1)
 *  - limit (default 50)
 */
exports.getClasses = async (request, reply) => {
  try {
    const { q, is_active, page = 1, limit = 50 } = request.query || {};

    const where = {};

    // 🔍 Text search
    if (q && String(q).trim()) {
      const search = String(q).trim();
      where[Op.or] = [{ class_name: { [Op.like]: `%${search}%` } }];
    }

    // Filter by active status
    if (typeof is_active !== "undefined") {
      if (is_active === "true" || is_active === "1") where.is_active = true;
      if (is_active === "false" || is_active === "0") where.is_active = false;
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(limit, 10) || 50, 1);
    const offset = (pageNum - 1) * pageSize;

    const { rows, count } = await Class.findAndCountAll({
      where,
      order: [
        ["sort_order", "ASC"],
        ["class_name", "ASC"],
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
    request.log.error({ err }, "Error in getClasses");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to fetch classes",
    });
  }
};

/**
 * GET /api/classes/:id
 */
exports.getClassById = async (request, reply) => {
  try {
    const { id } = request.params;

    const cls = await Class.findByPk(id);

    if (!cls) {
      return reply.code(404).send({ message: "Class not found" });
    }

    return reply.send(cls);
  } catch (err) {
    request.log.error({ err }, "Error in getClassById");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to fetch class",
    });
  }
};

/**
 * POST /api/classes
 * Body:
 *  - class_name*  (string)
 *  - sort_order   (number, optional)
 *  - is_active    (boolean, default true)
 */
exports.createClass = async (request, reply) => {
  const t = await sequelize.transaction();
  try {
    const { class_name, sort_order, is_active = true } = request.body || {};

    if (!class_name || !String(class_name).trim()) {
      await t.rollback();
      return reply.code(400).send({
        message: "class_name is required.",
      });
    }

    // Optional: prevent duplicate
    const existing = await Class.findOne({
      where: { class_name: String(class_name).trim() },
      transaction: t,
    });
    if (existing) {
      await t.rollback();
      return reply.code(400).send({
        message: "Class with this name already exists.",
      });
    }

    const cls = await Class.create(
      {
        class_name: String(class_name).trim(),
        sort_order:
          typeof sort_order !== "undefined" && sort_order !== null
            ? Number(sort_order)
            : 0,
        is_active: Boolean(is_active),
      },
      { transaction: t }
    );

    await t.commit();
    return reply.code(201).send(cls);
  } catch (err) {
    await t.rollback();
    request.log.error({ err }, "Error in createClass");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to create class",
    });
  }
};

/**
 * PUT /api/classes/:id
 * Body:
 *  - class_name   (string, optional)
 *  - sort_order   (number, optional)
 *  - is_active    (boolean, optional)
 */
exports.updateClass = async (request, reply) => {
  const t = await sequelize.transaction();
  try {
    const { id } = request.params;

    const cls = await Class.findByPk(id);
    if (!cls) {
      await t.rollback();
      return reply.code(404).send({ message: "Class not found" });
    }

    const { class_name, sort_order, is_active } = request.body || {};

    if (typeof class_name !== "undefined") {
      const value = String(class_name).trim();
      if (!value) {
        await t.rollback();
        return reply.code(400).send({ message: "class_name cannot be empty." });
      }

      // Check duplicate name (other id)
      const existing = await Class.findOne({
        where: {
          class_name: value,
          id: { [Op.ne]: cls.id },
        },
        transaction: t,
      });

      if (existing) {
        await t.rollback();
        return reply.code(400).send({
          message: "Another class with this name already exists.",
        });
      }

      cls.class_name = value;
    }

    if (typeof sort_order !== "undefined") {
      cls.sort_order =
        sort_order === null || sort_order === ""
          ? 0
          : Number(sort_order) || 0;
    }

    if (typeof is_active !== "undefined") {
      cls.is_active = Boolean(is_active);
    }

    await cls.save({ transaction: t });
    await t.commit();

    return reply.send(cls);
  } catch (err) {
    await t.rollback();
    request.log.error({ err }, "Error in updateClass");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to update class",
    });
  }
};

/**
 * DELETE /api/classes/:id
 * (Hard delete. If you want soft delete, change to is_active = false instead.)
 */
exports.deleteClass = async (request, reply) => {
  const t = await sequelize.transaction();
  try {
    const { id } = request.params;

    const cls = await Class.findByPk(id);
    if (!cls) {
      await t.rollback();
      return reply.code(404).send({ message: "Class not found" });
    }

    await cls.destroy({ transaction: t });
    await t.commit();

    return reply.send({ message: "Class deleted successfully" });
  } catch (err) {
    await t.rollback();
    request.log.error({ err }, "Error in deleteClass");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to delete class",
    });
  }
};

/* ------------ BULK IMPORT: POST /api/classes/import ------------ */
/**
 * Expected columns (case-insensitive):
 *  - ID
 *  - Class Name
 *  - Sort Order
 *  - Is Active
 */
exports.importClasses = async (request, reply) => {
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
    const rowNumber = index + 2; // header assumed at row 1
    const t = await sequelize.transaction();
    try {
      const id = row.ID || row.Id || row.id || null;
      const classNameRaw =
        row["Class Name"] ||
        row["Class"] ||
        row.class_name ||
        row.Class ||
        row.Name ||
        "";

      const sortOrderRaw =
        row["Sort Order"] || row.sort_order || row.SortOrder || "";

      const isActiveRaw =
        row["Is Active"] || row.is_active || row.IsActive || true;

      const class_name = String(classNameRaw || "").trim();

      if (!class_name) {
        await t.rollback();
        continue; // skip empty row
      }

      const is_active =
        typeof isActiveRaw === "string"
          ? !["0", "false", "no", "inactive"].includes(
              isActiveRaw.toLowerCase().trim()
            )
          : Boolean(isActiveRaw);

      const sort_order =
        sortOrderRaw === "" || sortOrderRaw === null || sortOrderRaw === undefined
          ? 0
          : Number(sortOrderRaw) || 0;

      const payload = {
        class_name,
        sort_order,
        is_active,
      };

      if (id) {
        const existing = await Class.findByPk(id, { transaction: t });
        if (existing) {
          // Optional: avoid name clash with other records
          const nameConflict = await Class.findOne({
            where: {
              class_name,
              id: { [Op.ne]: existing.id },
            },
            transaction: t,
          });
          if (nameConflict) {
            errors.push({
              row: rowNumber,
              error: `Another class with name "${class_name}" already exists.`,
            });
            await t.rollback();
            continue;
          }

          await existing.update(payload, { transaction: t });
          await t.commit();
          updatedCount++;
          continue;
        }
      }

      // If no ID or not found: try by name (upsert by name)
      const byName = await Class.findOne({
        where: { class_name },
        transaction: t,
      });

      if (byName) {
        await byName.update(payload, { transaction: t });
        await t.commit();
        updatedCount++;
      } else {
        await Class.create(payload, { transaction: t });
        await t.commit();
        createdCount++;
      }
    } catch (err) {
      await t.rollback();
      errors.push({
        row: rowNumber,
        error: err.message,
      });
    }
  }

  return {
    message: "Classes import completed",
    created: createdCount,
    updated: updatedCount,
    errors,
  };
};

/* ------------ BULK EXPORT: GET /api/classes/export ------------ */
/**
 * Export with:
 *  - Sheet "Classes": data rows
 */
exports.exportClasses = async (request, reply) => {
  try {
    const classes = await Class.findAll({
      order: [
        ["sort_order", "ASC"],
        ["class_name", "ASC"],
      ],
    });

    const workbook = new ExcelJS.Workbook();

    // Sheet 1: Classes
    const sheet = workbook.addWorksheet("Classes");

    sheet.columns = [
      { header: "ID", key: "id", width: 8 },
      { header: "Class Name", key: "class_name", width: 30 },
      { header: "Sort Order", key: "sort_order", width: 12 },
      { header: "Is Active", key: "is_active", width: 12 },
    ];

    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).alignment = {
      vertical: "middle",
      horizontal: "center",
    };

    classes.forEach((c) => {
      sheet.addRow({
        id: c.id,
        class_name: c.class_name,
        sort_order: c.sort_order,
        is_active: c.is_active ? "TRUE" : "FALSE",
      });
    });

    // Freeze header row
    sheet.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];

    const buffer = await workbook.xlsx.writeBuffer();

    reply
      .header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      )
      .header("Content-Disposition", 'attachment; filename="classes.xlsx"')
      .send(Buffer.from(buffer));
  } catch (err) {
    request.log.error({ err }, "Error in exportClasses");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to export classes",
    });
  }
};
