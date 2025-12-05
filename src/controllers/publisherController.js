// src/controllers/publisherController.js

const { Publisher, sequelize } = require("../models");
const XLSX = require("xlsx");

/* ============================================================
    GET LIST OF PUBLISHERS   → GET /api/publishers
============================================================ */
async function getPublishers(request, reply) {
  try {
    const { q, is_active } = request.query || {};
    const where = {};

    if (q && String(q).trim()) {
      const search = String(q).trim();
      where.name = { [require("sequelize").Op.like]: `%${search}%` };
    }

    if (typeof is_active !== "undefined") {
      if (is_active === "true" || is_active === "1") where.is_active = true;
      if (is_active === "false" || is_active === "0") where.is_active = false;
    }

    const publishers = await Publisher.findAll({
      where,
      order: [["name", "ASC"]],
    });

    return reply.send(publishers);
  } catch (err) {
    request.log.error({ err }, "Error in getPublishers");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to fetch publishers",
    });
  }
}

/* ============================================================
    GET SINGLE PUBLISHER  → GET /api/publishers/:id
============================================================ */
async function getPublisherById(request, reply) {
  try {
    const { id } = request.params;
    const publisher = await Publisher.findByPk(id);
    if (!publisher) {
      return reply.code(404).send({ message: "Publisher not found" });
    }
    return reply.send(publisher);
  } catch (err) {
    request.log.error({ err }, "Error in getPublisherById");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to fetch publisher",
    });
  }
}

/* ============================================================
    CREATE PUBLISHER  → POST /api/publishers
============================================================ */
async function createPublisher(request, reply) {
  const t = await sequelize.transaction();
  try {
    const { name, contact_person, phone, email, address, is_active = true } =
      request.body || {};

    if (!name) {
      await t.rollback();
      return reply.code(400).send({ message: "Name is required." });
    }

    const publisher = await Publisher.create(
      {
        name: name.trim(),
        contact_person: contact_person ? contact_person.trim() : null,
        phone: phone ? phone.trim() : null,
        email: email ? email.trim() : null,
        address: address ? address.trim() : null,
        is_active: Boolean(is_active),
      },
      { transaction: t }
    );

    await t.commit();
    return reply.code(201).send(publisher);
  } catch (err) {
    await t.rollback();
    request.log.error({ err }, "Error in createPublisher");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to create publisher",
    });
  }
}

/* ============================================================
    UPDATE PUBLISHER  → PUT /api/publishers/:id
============================================================ */
async function updatePublisher(request, reply) {
  const t = await sequelize.transaction();
  try {
    const { id } = request.params;
    const publisher = await Publisher.findByPk(id);

    if (!publisher) {
      await t.rollback();
      return reply.code(404).send({ message: "Publisher not found" });
    }

    const { name, contact_person, phone, email, address, is_active } =
      request.body || {};

    if (name !== undefined) publisher.name = name ? name.trim() : "";
    if (contact_person !== undefined)
      publisher.contact_person = contact_person ? contact_person.trim() : null;
    if (phone !== undefined) publisher.phone = phone ? phone.trim() : null;
    if (email !== undefined) publisher.email = email ? email.trim() : null;
    if (address !== undefined)
      publisher.address = address ? address.trim() : null;
    if (is_active !== undefined) publisher.is_active = Boolean(is_active);

    await publisher.save({ transaction: t });
    await t.commit();

    return reply.send(publisher);
  } catch (err) {
    await t.rollback();
    request.log.error({ err }, "Error in updatePublisher");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to update publisher",
    });
  }
}

/* ============================================================
    DELETE PUBLISHER  → DELETE /api/publishers/:id
============================================================ */
async function deletePublisher(request, reply) {
  const t = await sequelize.transaction();
  try {
    const { id } = request.params;
    const publisher = await Publisher.findByPk(id);

    if (!publisher) {
      await t.rollback();
      return reply.code(404).send({ message: "Publisher not found" });
    }

    await publisher.destroy({ transaction: t });
    await t.commit();

    return reply.send({ message: "Publisher deleted successfully" });
  } catch (err) {
    await t.rollback();
    request.log.error({ err }, "Error in deletePublisher");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to delete publisher",
    });
  }
}

/* ============================================================
    BULK IMPORT  → POST /api/publishers/import
============================================================ */
async function importPublishers(request, reply) {
  const file = await request.file();
  if (!file) {
    return reply.code(400).send({ error: "No file uploaded" });
  }

  const chunks = [];
  for await (const chunk of file.file) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer" });
  } catch {
    return reply.code(400).send({ error: "Invalid Excel file" });
  }

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  let createdCount = 0,
    updatedCount = 0;
  const errors = [];

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2; // considering header in row 1

    try {
      const id = row.ID || row.id || null;
      const name = row.Name || row.name || "";

      if (!name) continue;

      const payload = {
        name,
        contact_person: row["Contact Person"] || row.contact_person || null,
        phone: row.Phone || row.phone || null,
        email: row.Email || row.email || null,
        address: row.Address || row.address || null,
        is_active:
          String(row["Is Active"]).toLowerCase() !== "false" &&
          String(row["Is Active"]).toLowerCase() !== "0",
      };

      if (id) {
        const existing = await Publisher.findByPk(id);
        if (existing) {
          await existing.update(payload);
          updatedCount++;
          continue;
        }
      }

      await Publisher.create(payload);
      createdCount++;
    } catch (err) {
      errors.push({ row: rowNumber, error: err.message });
    }
  }

  return reply.send({
    message: "Publishers import completed",
    created: createdCount,
    updated: updatedCount,
    errors,
  });
}

/* ============================================================
    BULK EXPORT  → GET /api/publishers/export
============================================================ */
async function exportPublishers(request, reply) {
  const publishers = await Publisher.findAll({
    order: [["id", "ASC"]],
  });

  const rows = publishers.map((p) => ({
    ID: p.id,
    Name: p.name,
    "Contact Person": p.contact_person,
    Phone: p.phone,
    Email: p.email,
    Address: p.address,
    "Is Active": p.is_active,
  }));

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Publishers");

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  reply
    .header(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    .header("Content-Disposition", 'attachment; filename="publishers.xlsx"')
    .send(buffer);
}

/* ============================================================
    EXPORT ALL HANDLERS
============================================================ */
module.exports = {
  getPublishers,
  getPublisherById,
  createPublisher,
  updatePublisher,
  deletePublisher,
  importPublishers,
  exportPublishers,
};
