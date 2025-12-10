// src/controllers/transportController.js

const { Transport, sequelize } = require("../models");
const { Op } = require("sequelize");
const XLSX = require("xlsx");

/* ============================================================
    GET LIST OF TRANSPORTS   → GET /api/transports
============================================================ */
async function getTransports(request, reply) {
  try {
    const { q, is_active } = request.query || {};
    const where = {};

    if (q && String(q).trim()) {
      const search = String(q).trim();
      where[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { contact_person: { [Op.like]: `%${search}%` } },
        { phone: { [Op.like]: `%${search}%` } },
      ];
    }

    if (typeof is_active !== "undefined") {
      if (is_active === "true" || is_active === "1") where.is_active = true;
      if (is_active === "false" || is_active === "0") where.is_active = false;
    }

    const transports = await Transport.findAll({
      where,
      order: [["name", "ASC"]],
    });

    // ✅ send plain JSON (defensive against BigInt etc.)
    const plain = transports.map((t) =>
      typeof t.toJSON === "function" ? t.toJSON() : t
    );

    return reply.code(200).send(plain);
  } catch (err) {
    request.log?.error({ err }, "Error in getTransports");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to fetch transports",
    });
  }
}

/* ============================================================
    GET SINGLE TRANSPORT  → GET /api/transports/:id
============================================================ */
async function getTransportById(request, reply) {
  try {
    const { id } = request.params;
    const transport = await Transport.findByPk(id);

    if (!transport) {
      return reply.code(404).send({ message: "Transport not found" });
    }

    const plain =
      typeof transport.toJSON === "function" ? transport.toJSON() : transport;

    return reply.code(200).send(plain);
  } catch (err) {
    request.log?.error({ err }, "Error in getTransportById");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to fetch transport",
    });
  }
}

/* ============================================================
    CREATE TRANSPORT  → POST /api/transports
============================================================ */
async function createTransport(request, reply) {
  const t = await sequelize.transaction();
  try {
    const {
      name,
      contact_person,
      phone,
      email,
      address,
      gst_no,
      pan_no,
      notes,
      is_active = true,
    } = request.body || {};

    if (!name) {
      await t.rollback();
      return reply.code(400).send({ message: "Name is required." });
    }

    const transport = await Transport.create(
      {
        name: name.trim(),
        contact_person: contact_person ? contact_person.trim() : null,
        phone: phone ? phone.trim() : null,
        email: email ? email.trim() : null,
        address: address ? address.trim() : null,
        gst_no: gst_no ? gst_no.trim() : null,
        pan_no: pan_no ? pan_no.trim() : null,
        notes: notes ? notes.trim() : null,
        is_active: Boolean(is_active),
      },
      { transaction: t }
    );

    await t.commit();

    const plain =
      typeof transport.toJSON === "function" ? transport.toJSON() : transport;

    return reply.code(201).send(plain);
  } catch (err) {
    await t.rollback();
    request.log?.error({ err }, "Error in createTransport");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to create transport",
    });
  }
}

/* ============================================================
    UPDATE TRANSPORT  → PUT /api/transports/:id
============================================================ */
async function updateTransport(request, reply) {
  const t = await sequelize.transaction();
  try {
    const { id } = request.params;
    const transport = await Transport.findByPk(id);

    if (!transport) {
      await t.rollback();
      return reply.code(404).send({ message: "Transport not found" });
    }

    const {
      name,
      contact_person,
      phone,
      email,
      address,
      gst_no,
      pan_no,
      notes,
      is_active,
    } = request.body || {};

    if (name !== undefined) transport.name = name ? name.trim() : "";
    if (contact_person !== undefined)
      transport.contact_person = contact_person
        ? contact_person.trim()
        : null;
    if (phone !== undefined) transport.phone = phone ? phone.trim() : null;
    if (email !== undefined) transport.email = email ? email.trim() : null;
    if (address !== undefined)
      transport.address = address ? address.trim() : null;
    if (gst_no !== undefined)
      transport.gst_no = gst_no ? gst_no.trim() : null;
    if (pan_no !== undefined)
      transport.pan_no = pan_no ? pan_no.trim() : null;
    if (notes !== undefined) transport.notes = notes ? notes.trim() : null;
    if (is_active !== undefined) transport.is_active = Boolean(is_active);

    await transport.save({ transaction: t });
    await t.commit();

    const plain =
      typeof transport.toJSON === "function" ? transport.toJSON() : transport;

    return reply.code(200).send(plain);
  } catch (err) {
    await t.rollback();
    request.log?.error({ err }, "Error in updateTransport");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to update transport",
    });
  }
}

/* ============================================================
    DELETE TRANSPORT  → DELETE /api/transports/:id
============================================================ */
async function deleteTransport(request, reply) {
  const t = await sequelize.transaction();
  try {
    const { id } = request.params;
    const transport = await Transport.findByPk(id);

    if (!transport) {
      await t.rollback();
      return reply.code(404).send({ message: "Transport not found" });
    }

    await transport.destroy({ transaction: t });
    await t.commit();

    return reply
      .code(200)
      .send({ message: "Transport deleted successfully" });
  } catch (err) {
    await t.rollback();
    request.log?.error({ err }, "Error in deleteTransport");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to delete transport",
    });
  }
}

/* ============================================================
    BULK IMPORT  → POST /api/transports/import
============================================================ */
async function importTransports(request, reply) {
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
  } catch (err) {
    request.log?.error({ err }, "Error reading Excel in importTransports");
    return reply.code(400).send({ error: "Invalid Excel file" });
  }

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  let createdCount = 0;
  let updatedCount = 0;
  const errors = [];

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2; // row 1 is header

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
        gst_no: row["GST No"] || row.gst_no || null,
        pan_no: row["PAN No"] || row.pan_no || null,
        notes: row.Notes || row.notes || null,
        is_active:
          String(row["Is Active"]).toLowerCase() !== "false" &&
          String(row["Is Active"]).toLowerCase() !== "0",
      };

      if (id) {
        const existing = await Transport.findByPk(id);
        if (existing) {
          await existing.update(payload);
          updatedCount++;
          continue;
        }
      }

      await Transport.create(payload);
      createdCount++;
    } catch (err) {
      errors.push({ row: rowNumber, error: err.message });
    }
  }

  return reply.code(200).send({
    message: "Transports import completed",
    created: createdCount,
    updated: updatedCount,
    errors,
  });
}

/* ============================================================
    BULK EXPORT  → GET /api/transports/export
============================================================ */
async function exportTransports(request, reply) {
  try {
    const transports = await Transport.findAll({
      order: [["id", "ASC"]],
    });

    const rows = transports.map((t) => ({
      ID: t.id,
      Name: t.name,
      "Contact Person": t.contact_person,
      Phone: t.phone,
      Email: t.email,
      Address: t.address,
      "GST No": t.gst_no,
      "PAN No": t.pan_no,
      Notes: t.notes,
      "Is Active": t.is_active,
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Transports");

    const buffer = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    });

    reply
      .header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      )
      .header("Content-Disposition", 'attachment; filename="transports.xlsx"')
      .send(buffer);
  } catch (err) {
    request.log?.error({ err }, "Error in exportTransports");
    return reply.code(500).send({
      error: "InternalServerError",
      message: err.message || "Failed to export transports",
    });
  }
}

/* ============================================================
    EXPORT ALL HANDLERS
============================================================ */
module.exports = {
  getTransports,
  getTransportById,
  createTransport,
  updateTransport,
  deleteTransport,
  importTransports,
  exportTransports,
};
