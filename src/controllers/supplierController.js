// src/controllers/supplierController.js
const { Supplier, Publisher, sequelize } = require("../models");

/* ---------------- Helpers ---------------- */

const cleanStr = (v) => {
  if (v === undefined || v === null) return "";
  return String(v).trim();
};

const cleanNullable = (v) => {
  const s = cleanStr(v);
  return s ? s : null;
};

const toBool = (v, defaultValue = true) => {
  if (v === undefined || v === null || v === "") return defaultValue;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return defaultValue;
};

/* =========================================
 * CREATE Supplier
 * → Auto-create Publisher with same details
 * Fastify handler: (request, reply)
 * ========================================= */
exports.create = async (request, reply) => {
  const t = await sequelize.transaction();
  try {
    const {
      name,
      contact_person,
      phone,
      email,
      address,
      is_active = true,
    } = request.body || {};

    const cleanName = cleanStr(name);
    if (!cleanName) {
      await t.rollback();
      return reply.code(400).send({ error: "Supplier name is required." });
    }

    // 1️⃣ Create Supplier
    const supplier = await Supplier.create(
      {
        name: cleanName,
        contact_person: cleanNullable(contact_person),
        phone: cleanNullable(phone),
        email: cleanNullable(email),
        address: cleanNullable(address),
        is_active: toBool(is_active, true),
      },
      { transaction: t }
    );

    // 2️⃣ Auto-create Publisher (same details)
    await Publisher.create(
      {
        name: supplier.name,
        contact_person: supplier.contact_person,
        phone: supplier.phone,
        email: supplier.email,
        address: supplier.address,
        is_active: supplier.is_active,
      },
      { transaction: t }
    );

    await t.commit();

    return reply.code(201).send({
      message: "Supplier created successfully. Publisher auto-created.",
      supplier,
    });
  } catch (err) {
    await t.rollback();
    request.log?.error({ err }, "Create Supplier Error");

    if (err?.name === "SequelizeUniqueConstraintError") {
      return reply
        .code(409)
        .send({ error: "Supplier with this name already exists." });
    }

    return reply.code(500).send({ error: "Failed to create supplier." });
  }
};

/* =========================================
 * READ – List all suppliers
 * ========================================= */
exports.list = async (request, reply) => {
  try {
    const suppliers = await Supplier.findAll({
      order: [["id", "DESC"]],
    });

    return reply.send(suppliers);
  } catch (err) {
    request.log?.error({ err }, "List Suppliers Error");
    return reply.code(500).send({ error: "Failed to fetch suppliers." });
  }
};

/* =========================================
 * READ – Get supplier by ID
 * ========================================= */
exports.getById = async (request, reply) => {
  try {
    const supplier = await Supplier.findByPk(request.params.id);

    if (!supplier) {
      return reply.code(404).send({ error: "Supplier not found." });
    }

    return reply.send(supplier);
  } catch (err) {
    request.log?.error({ err }, "Get Supplier Error");
    return reply.code(500).send({ error: "Failed to fetch supplier." });
  }
};

/* =========================================
 * UPDATE Supplier
 * (Does NOT touch Publisher)
 * ========================================= */
exports.update = async (request, reply) => {
  try {
    const supplier = await Supplier.findByPk(request.params.id);

    if (!supplier) {
      return reply.code(404).send({ error: "Supplier not found." });
    }

    const { name, contact_person, phone, email, address, is_active } =
      request.body || {};

    if (name !== undefined && !cleanStr(name)) {
      return reply.code(400).send({ error: "Supplier name cannot be empty." });
    }

    await supplier.update({
      name: name !== undefined ? cleanStr(name) : supplier.name,
      contact_person:
        contact_person !== undefined
          ? cleanNullable(contact_person)
          : supplier.contact_person,
      phone: phone !== undefined ? cleanNullable(phone) : supplier.phone,
      email: email !== undefined ? cleanNullable(email) : supplier.email,
      address: address !== undefined ? cleanNullable(address) : supplier.address,
      is_active:
        is_active !== undefined ? toBool(is_active, supplier.is_active) : supplier.is_active,
    });

    return reply.send({
      message: "Supplier updated successfully.",
      supplier,
    });
  } catch (err) {
    request.log?.error({ err }, "Update Supplier Error");

    if (err?.name === "SequelizeUniqueConstraintError") {
      return reply
        .code(409)
        .send({ error: "Supplier with this name already exists." });
    }

    return reply.code(500).send({ error: "Failed to update supplier." });
  }
};

/* =========================================
 * DELETE Supplier (Soft delete)
 * Publisher is NOT deleted
 * ========================================= */
exports.remove = async (request, reply) => {
  try {
    const supplier = await Supplier.findByPk(request.params.id);

    if (!supplier) {
      return reply.code(404).send({ error: "Supplier not found." });
    }

    await supplier.update({ is_active: false });

    return reply.send({
      message: "Supplier deleted (soft delete).",
    });
  } catch (err) {
    request.log?.error({ err }, "Delete Supplier Error");
    return reply.code(500).send({ error: "Failed to delete supplier." });
  }
};
