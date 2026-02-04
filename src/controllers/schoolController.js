// controllers/schoolController.js
"use strict";

const { Op } = require("sequelize");
const XLSX = require("xlsx"); // ⭐ for Excel import
const ExcelJS = require("exceljs"); // ⭐ for Excel export

const {
  School,
  sequelize,

  // ✅ Mapping model (your Option A)
  DistributorSchool,
} = require("../models");

/* ================= Helpers (RBAC + Distributor School Filter) ================= */

const ADMINISH_ROLES = ["ADMIN", "SUPERADMIN", "OWNER", "STAFF", "ACCOUNTANT"];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function getUserRoles(user) {
  const r = user?.roles ?? user?.role ?? [];
  if (Array.isArray(r)) return r.map((x) => String(x).toUpperCase());
  return [String(r).toUpperCase()];
}

function isAdminish(user) {
  const roles = getUserRoles(user);
  return ADMINISH_ROLES.some((r) => roles.includes(r));
}

function isDistributorUser(user) {
  const roles = getUserRoles(user);
  return roles.includes("DISTRIBUTOR");
}

function getDistributorIdFromUser(user) {
  // Prefer explicit distributor_id fields; otherwise fallback to user.id (common setup)
  const explicit =
    Number(
      user?.distributor_id ||
        user?.distributorId ||
        user?.DistributorId ||
        user?.distributor?.id ||
        0
    ) || 0;

  return explicit || (Number(user?.id) || 0);
}

/**
 * ✅ Returns:
 * - null  => no restriction (admin-ish)
 * - []    => restricted but none
 * - [ids] => allowed school ids
 */
async function getAllowedSchoolIdsForUser(request, t) {
  const user = request.user;

  if (isAdminish(user)) return null;

  if (!isDistributorUser(user)) {
    const err = new Error("Not allowed to list schools");
    err.statusCode = 403;
    throw err;
  }

  const distributorId = getDistributorIdFromUser(user);
  if (!distributorId) {
    const err = new Error("Distributor user not linked (missing distributor_id)");
    err.statusCode = 403;
    throw err;
  }

  // ✅ Option A: DistributorSchool mapping table
  if (!DistributorSchool || !DistributorSchool.findAll) {
    const err = new Error(
      "School restriction not configured. Missing DistributorSchool model."
    );
    err.statusCode = 500;
    throw err;
  }

  // Filter only active mapping if column exists
  const dsCols = DistributorSchool.rawAttributes || {};
  const dsWhere = { distributor_id: distributorId };
  if (dsCols.is_active) dsWhere.is_active = true;

  const rows = await DistributorSchool.findAll({
    where: dsWhere,
    attributes: ["school_id"],
    transaction: t || undefined,
  });

  const ids = rows
    .map((r) => {
      const o = r?.toJSON ? r.toJSON() : r;
      return num(o.school_id);
    })
    .filter((x) => x > 0);

  return Array.from(new Set(ids));
}

/**
 * ✅ Apply restriction to a query
 */
async function buildRestrictedWhere(request, baseWhere = {}, t) {
  const allowedIds = await getAllowedSchoolIdsForUser(request, t);
  if (allowedIds === null) return baseWhere; // admin => all
  return {
    ...baseWhere,
    id: { [Op.in]: allowedIds.length ? allowedIds : [-1] },
  };
}

/* =========================
 * GET /api/schools (restricted for distributor users)
 * Query params:
 *  - q: search text (name, contact_person, city)
 *  - is_active (true/false)
 *  - page (default 1)
 *  - limit (default 50)
 * ========================= */
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

    // ✅ Restrict for distributor user
    const restrictedWhere = await buildRestrictedWhere(request, where);

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(limit, 10) || 50, 1);
    const offset = (pageNum - 1) * pageSize;

    const { rows, count } = await School.findAndCountAll({
      where: restrictedWhere,
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
    const code = err.statusCode || 500;
    request.log.error({ err }, "Error in getSchools");
    return reply.code(code).send({
      error: code === 403 ? "Forbidden" : "InternalServerError",
      message: err.message || "Failed to fetch schools",
    });
  }
};

/**
 * ✅ NEW: GET /api/schools/my/schools
 * Returns only allowed schools for current user
 */
exports.getMySchools = async (request, reply) => {
  try {
    const restrictedWhere = await buildRestrictedWhere(request, {});
    const rows = await School.findAll({
      where: restrictedWhere,
      order: [
        ["sort_order", "ASC"],
        ["name", "ASC"],
      ],
      limit: 2000,
    });

    return reply.send({ data: rows });
  } catch (err) {
    const code = err.statusCode || 500;
    request.log.error({ err }, "Error in getMySchools");
    return reply.code(code).send({
      error: code === 403 ? "Forbidden" : "InternalServerError",
      message: err.message || "Failed to fetch schools",
    });
  }
};

/**
 * GET /api/schools/:id  (restricted for distributor users)
 */
exports.getSchoolById = async (request, reply) => {
  try {
    const { id } = request.params;

    // ✅ Restrict access
    const restrictedWhere = await buildRestrictedWhere(request, { id: num(id) });

    const school = await School.findOne({ where: restrictedWhere });

    if (!school) {
      return reply.code(404).send({ message: "School not found" });
    }

    return reply.send(school);
  } catch (err) {
    const code = err.statusCode || 500;
    request.log.error({ err }, "Error in getSchoolById");
    return reply.code(code).send({
      error: code === 403 ? "Forbidden" : "InternalServerError",
      message: err.message || "Failed to fetch school",
    });
  }
};

/**
 * POST /api/schools
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
      return reply.code(400).send({ message: "name is required." });
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
      school.city = city === null || city === "" ? null : String(city).trim();
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
exports.exportSchools = async (request, reply) => {
  try {
    // ✅ Restrict export for distributor user as well
    const restrictedWhere = await buildRestrictedWhere(request, {});

    const schools = await School.findAll({
      where: restrictedWhere,
      order: [
        ["sort_order", "ASC"],
        ["name", "ASC"],
      ],
    });

    const workbook = new ExcelJS.Workbook();
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
    const code = err.statusCode || 500;
    request.log.error({ err }, "Error in exportSchools");
    return reply.code(code).send({
      error: code === 403 ? "Forbidden" : "InternalServerError",
      message: err.message || "Failed to export schools",
    });
  }
};
