// src/controllers/distributorController.js
"use strict";

const { Op } = require("sequelize");
const { Distributor } = require("../models");

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function list(request, reply) {
  try {
    const { q, is_active } = request.query || {};
    const where = {};

    if (typeof is_active !== "undefined") {
      where.is_active = String(is_active) === "true";
    }

    if (q && String(q).trim()) {
      const s = String(q).trim();
      where.name = { [Op.like]: `%${s}%` };
    }

    const rows = await Distributor.findAll({
      where,
      order: [["id", "DESC"]],
    });

    return reply.send({ rows });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ message: "Internal Server Error" });
  }
}

async function create(request, reply) {
  try {
    const body = request.body || {};
    const name = String(body.name || "").trim();
    if (!name) return reply.code(400).send({ message: "name is required" });

    const row = await Distributor.create({
      name,
      mobile: body.mobile ? String(body.mobile).trim() : null,
      email: body.email ? String(body.email).trim() : null,
      address: body.address ? String(body.address).trim() : null,
      city: body.city ? String(body.city).trim() : null,
      is_active: typeof body.is_active === "boolean" ? body.is_active : true,
    });

    return reply.send({ message: "Distributor created", row });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ message: "Internal Server Error" });
  }
}

async function update(request, reply) {
  try {
    const id = num(request.params?.id);
    if (!id) return reply.code(400).send({ message: "Invalid distributor id" });

    const row = await Distributor.findByPk(id);
    if (!row) return reply.code(404).send({ message: "Distributor not found" });

    const body = request.body || {};
    const patch = {};

    if (typeof body.name !== "undefined") {
      const name = String(body.name || "").trim();
      if (!name) return reply.code(400).send({ message: "name cannot be empty" });
      patch.name = name;
    }
    if (typeof body.mobile !== "undefined") patch.mobile = body.mobile ? String(body.mobile).trim() : null;
    if (typeof body.email !== "undefined") patch.email = body.email ? String(body.email).trim() : null;
    if (typeof body.address !== "undefined") patch.address = body.address ? String(body.address).trim() : null;
    if (typeof body.city !== "undefined") patch.city = body.city ? String(body.city).trim() : null;
    if (typeof body.is_active !== "undefined") patch.is_active = Boolean(body.is_active);

    await row.update(patch);
    return reply.send({ message: "Distributor updated", row });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ message: "Internal Server Error" });
  }
}

async function remove(request, reply) {
  try {
    const id = num(request.params?.id);
    if (!id) return reply.code(400).send({ message: "Invalid distributor id" });

    const row = await Distributor.findByPk(id);
    if (!row) return reply.code(404).send({ message: "Distributor not found" });

    await row.update({ is_active: false });
    return reply.send({ message: "Distributor deactivated", id });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ message: "Internal Server Error" });
  }
}

module.exports = { list, create, update, remove };
