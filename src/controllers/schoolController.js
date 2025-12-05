// controllers/schoolController.js

const { School, sequelize } = require("../models");
const { Op } = require("sequelize");
const XLSX = require("xlsx"); // ⭐ for Excel import
const ExcelJS = require("exceljs"); // ⭐ for Excel export

/**
 * GET /api/schools
 * Query params:
 *  - q: search text (name, contact_person, city)
 *  - is_active (true/false)
 *  - page (default 1)
 *  - limit (default 50)
 */
exports.getSchools = async (request, reply) => {
  try {
    const { q, is_active, page = 1, limit = 50 } = request.query || {};

    const where = {};

    // 🔍 Text search
    if (q && String(q).trim()) {
      const search = String(q).trim();
      where[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { contact_person: { [Op.like]: `%${search}%` } },
        { city: { [Op.like]: `%${search}%` } },
      ];
    }

    // Filter by active status
    if (typeof is_active !== "undefined") {
      if (is_active === "true" || is_active === "1") where.is_active = true;
      if (is_active === "false" || is_active === "0") where.is_active = false;
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(limit, 10) || 50, 1);
    const offset = (pageNum - 1) * pageSize;

    const { rows, count } = await School.findAndCountAll({
      where,
      order: [
        ["sort_order", "ASC"],
        ["name", "ASC"],
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
    request.log.error({ err }, "Error in getSchools");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to fetch schools",
    });
  }
};

/**
 * GET /api/schools/:id
 */
exports.getSchoolById = async (request, reply) => {
  try {
    const { id } = request.params;

    const school = await School.findByPk(id);

    if (!school) {
      return reply.code(404).send({ message: "School not found" });
    }

    return reply.send(school);
  } catch (err) {
    request.log.error({ err }, "Error in getSchoolById");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to fetch school",
    });
  }
};

/**
 * POST /api/schools
 * Body:
 *  - name*            (string)
 *  - contact_person   (string, optional)
 *  - phone            (string, optional)
 *  - email            (string, optional)
 *  - address          (string, optional)
 *  - city             (string, optional)
 *  - state            (string, optional)
 *  - pincode          (string, optional)
 *  - sort_order       (number, optional)
 *  - is_active        (boolean, default true)
 */
exports.createSchool = async (request, reply) => {
  const t = await sequelize.transaction();
  try {
    const {
      name,
      contact_person,
      phone,
      email,
      address,
      city,
      state,
      pincode,
      sort_order,
      is_active = true,
    } = request.body || {};

    if (!name || !String(name).trim()) {
      await t.rollback();
      return reply.code(400).send({
        message: "name is required.",
      });
    }

    const trimmedName = String(name).trim();

    // Optional: prevent duplicate by name
    const existing = await School.findOne({
      where: { name: trimmedName },
      transaction: t,
    });

    if (existing) {
      await t.rollback();
      return reply.code(400).send({
        message: "School with this name already exists.",
      });
    }

    const school = await School.create(
      {
        name: trimmedName,
        contact_person: contact_person ? String(contact_person).trim() : null,
        phone: phone ? String(phone).trim() : null,
        email: email ? String(email).trim() : null,
        address: address ? String(address).trim() : null,
        city: city ? String(city).trim() : null,
        state: state ? String(state).trim() : null,
        pincode: pincode ? String(pincode).trim() : null,
        sort_order:
          typeof sort_order !== "undefined" && sort_order !== null
            ? Number(sort_order)
            : 0,
        is_active: Boolean(is_active),
      },
      { transaction: t }
    );

    await t.commit();
    return reply.code(201).send(school);
  } catch (err) {
    await t.rollback();
    request.log.error({ err }, "Error in createSchool");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to create school",
    });
  }
};

/**
 * PUT /api/schools/:id
 * Body:
 *  - name             (string, optional)
 *  - contact_person   (string, optional)
 *  - phone            (string, optional)
 *  - email            (string, optional)
 *  - address          (string, optional)
 *  - city             (string, optional)
 *  - state            (string, optional)
 *  - pincode          (string, optional)
 *  - sort_order       (number, optional)
 *  - is_active        (boolean, optional)
 */
exports.updateSchool = async (request, reply) => {
  const t = await sequelize.transaction();
  try {
    const { id } = request.params;

    const school = await School.findByPk(id);
    if (!school) {
      await t.rollback();
      return reply.code(404).send({ message: "School not found" });
    }

    const {
      name,
      contact_person,
      phone,
      email,
      address,
      city,
      state,
      pincode,
      sort_order,
      is_active,
    } = request.body || {};

    if (typeof name !== "undefined") {
      const value = String(name).trim();
      if (!value) {
        await t.rollback();
        return reply.code(400).send({ message: "name cannot be empty." });
      }

      // Check duplicate name (other id)
      const existing = await School.findOne({
        where: {
          name: value,
          id: { [Op.ne]: school.id },
        },
        transaction: t,
      });

      if (existing) {
        await t.rollback();
        return reply.code(400).send({
          message: "Another school with this name already exists.",
        });
      }

      school.name = value;
    }

    if (typeof contact_person !== "undefined") {
      school.contact_person =
        contact_person === null || contact_person === ""
          ? null
          : String(contact_person).trim();
    }

    if (typeof phone !== "undefined") {
      school.phone =
        phone === null || phone === "" ? null : String(phone).trim();
    }

    if (typeof email !== "undefined") {
      school.email =
        email === null || email === "" ? null : String(email).trim();
    }

    if (typeof address !== "undefined") {
      school.address =
        address === null || address === "" ? null : String(address).trim();
    }

    if (typeof city !== "undefined") {
      school.city =
        city === null || city === "" ? null : String(city).trim();
    }

    if (typeof state !== "undefined") {
      school.state =
        state === null || state === "" ? null : String(state).trim();
    }

    if (typeof pincode !== "undefined") {
      school.pincode =
        pincode === null || pincode === "" ? null : String(pincode).trim();
    }

    if (typeof sort_order !== "undefined") {
      school.sort_order =
        sort_order === null || sort_order === ""
          ? 0
          : Number(sort_order) || 0;
    }

    if (typeof is_active !== "undefined") {
      school.is_active = Boolean(is_active);
    }

    await school.save({ transaction: t });
    await t.commit();

    return reply.send(school);
  } catch (err) {
    await t.rollback();
    request.log.error({ err }, "Error in updateSchool");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to update school",
    });
  }
};

/**
 * DELETE /api/schools/:id
 * (Hard delete. If you want soft delete, change to is_active = false instead.)
 */
exports.deleteSchool = async (request, reply) => {
  const t = await sequelize.transaction();
  try {
    const { id } = request.params;

    const school = await School.findByPk(id);
    if (!school) {
      await t.rollback();
      return reply.code(404).send({ message: "School not found" });
    }

    await school.destroy({ transaction: t });
    await t.commit();

    return reply.send({ message: "School deleted successfully" });
  } catch (err) {
    await t.rollback();
    request.log.error({ err }, "Error in deleteSchool");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to delete school",
    });
  }
};

/* ------------ BULK IMPORT: POST /api/schools/import ------------ */
/**
 * Expected columns (case-insensitive):
 *  - ID
 *  - School Name / Name
 *  - Contact Person
 *  - Phone
 *  - Email
 *  - Address
 *  - City
 *  - State
 *  - Pincode
 *  - Sort Order
 *  - Is Active
 */
exports.importSchools = async (request, reply) => {
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

      const nameRaw =
        row["School Name"] ||
        row["Name"] ||
        row["School"] ||
        row.name ||
        row.school_name ||
        "";

      const contactPersonRaw =
        row["Contact Person"] ||
        row["Contact"] ||
        row.contact_person ||
        row.ContactPerson ||
        "";

      const phoneRaw =
        row["Phone"] || row["Mobile"] || row.phone || row.mobile || "";

      const emailRaw = row["Email"] || row.email || "";

      const addressRaw =
        row["Address"] || row.address || row["Full Address"] || "";

      const cityRaw = row["City"] || row.city || "";

      const stateRaw =
        row["State"] || row["State/UT"] || row.state || row.State || "";

      const pincodeRaw =
        row["Pincode"] ||
        row["PIN"] ||
        row["Postal Code"] ||
        row.pincode ||
        "";

      const sortOrderRaw =
        row["Sort Order"] || row.sort_order || row.SortOrder || "";

      const isActiveRaw =
        row["Is Active"] || row.is_active || row.IsActive || true;

      const name = String(nameRaw || "").trim();

      if (!name) {
        await t.rollback();
        continue; // skip empty row
      }

      const contact_person = String(contactPersonRaw || "").trim() || null;
      const phone = String(phoneRaw || "").trim() || null;
      const email = String(emailRaw || "").trim() || null;
      const address = String(addressRaw || "").trim() || null;
      const city = String(cityRaw || "").trim() || null;
      const state = String(stateRaw || "").trim() || null;
      const pincode = String(pincodeRaw || "").trim() || null;

      const is_active =
        typeof isActiveRaw === "string"
          ? !["0", "false", "no", "inactive"].includes(
              isActiveRaw.toLowerCase().trim()
            )
          : Boolean(isActiveRaw);

      const sort_order =
        sortOrderRaw === "" ||
        sortOrderRaw === null ||
        sortOrderRaw === undefined
          ? 0
          : Number(sortOrderRaw) || 0;

      const payload = {
        name,
        contact_person,
        phone,
        email,
        address,
        city,
        state,
        pincode,
        sort_order,
        is_active,
      };

      if (id) {
        const existing = await School.findByPk(id, { transaction: t });
        if (existing) {
          // Optional: avoid name clash with other records
          const nameConflict = await School.findOne({
            where: {
              name,
              id: { [Op.ne]: existing.id },
            },
            transaction: t,
          });
          if (nameConflict) {
            errors.push({
              row: rowNumber,
              error: `Another school with name "${name}" already exists.`,
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
      const byName = await School.findOne({
        where: { name },
        transaction: t,
      });

      if (byName) {
        await byName.update(payload, { transaction: t });
        await t.commit();
        updatedCount++;
      } else {
        await School.create(payload, { transaction: t });
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
    message: "Schools import completed",
    created: createdCount,
    updated: updatedCount,
    errors,
  };
};

/* ------------ BULK EXPORT: GET /api/schools/export ------------ */
/**
 * Export with:
 *  - Sheet "Schools": data rows
 */
exports.exportSchools = async (request, reply) => {
  try {
    const schools = await School.findAll({
      order: [
        ["sort_order", "ASC"],
        ["name", "ASC"],
      ],
    });

    const workbook = new ExcelJS.Workbook();

    // Sheet 1: Schools
    const sheet = workbook.addWorksheet("Schools");

    sheet.columns = [
      { header: "ID", key: "id", width: 8 },
      { header: "School Name", key: "name", width: 40 },
      { header: "Contact Person", key: "contact_person", width: 25 },
      { header: "Phone", key: "phone", width: 18 },
      { header: "Email", key: "email", width: 30 },
      { header: "Address", key: "address", width: 40 },
      { header: "City", key: "city", width: 18 },
      { header: "State", key: "state", width: 18 },
      { header: "Pincode", key: "pincode", width: 12 },
      { header: "Sort Order", key: "sort_order", width: 12 },
      { header: "Is Active", key: "is_active", width: 12 },
    ];

    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).alignment = {
      vertical: "middle",
      horizontal: "center",
    };

    schools.forEach((s) => {
      sheet.addRow({
        id: s.id,
        name: s.name,
        contact_person: s.contact_person,
        phone: s.phone,
        email: s.email,
        address: s.address,
        city: s.city,
        state: s.state,
        pincode: s.pincode,
        sort_order: s.sort_order,
        is_active: s.is_active ? "TRUE" : "FALSE",
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
      .header("Content-Disposition", 'attachment; filename="schools.xlsx"')
      .send(Buffer.from(buffer));
  } catch (err) {
    request.log.error({ err }, "Error in exportSchools");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to export schools",
    });
  }
};
