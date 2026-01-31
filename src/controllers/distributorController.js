"use strict";

const { Op } = require("sequelize");
const bcrypt = require("bcryptjs");
const { Distributor, User, sequelize } = require("../models");

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const safeStr = (v) => String(v ?? "").trim();

const randomPassword = (len = 8) => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
};

/* ---------------- LIST ---------------- */

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

/* ---------------- CREATE (ONLY DISTRIBUTOR) ---------------- */

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

/* ---------------- CREATE DISTRIBUTOR + USER (NEW) ----------------
 * POST /api/distributors/with-user
 *
 * body:
 *  {
 *    name, mobile, email, address, city, is_active,
 *    user_email, user_name, user_phone,
 *    password   (optional, auto-generate if missing)
 *  }
 *
 * Note: user_email is REQUIRED (users.email is unique + required in your model)
 */
async function createWithUser(request, reply) {
  const t = await sequelize.transaction();
  try {
    const body = request.body || {};

    // Distributor
    const name = safeStr(body.name);
    if (!name) return reply.code(400).send({ message: "name is required" });

    const distPayload = {
      name,
      mobile: safeStr(body.mobile) || null,
      email: safeStr(body.email) || null,
      address: safeStr(body.address) || null,
      city: safeStr(body.city) || null,
      is_active: typeof body.is_active === "boolean" ? body.is_active : true,
    };

    // User (login)
    const user_email = safeStr(body.user_email);
    if (!user_email) {
      await t.rollback();
      return reply.code(400).send({ message: "user_email is required (login email)" });
    }

    // ensure unique email
    const exists = await User.findOne({ where: { email: user_email }, transaction: t });
    if (exists) {
      await t.rollback();
      return reply.code(409).send({ message: "User with this email already exists" });
    }

    let password = safeStr(body.password);
    if (!password) password = randomPassword(8);

    const password_hash = await bcrypt.hash(password, 10);

    const userPayload = {
      name: safeStr(body.user_name) || `${name} (Distributor)`,
      email: user_email,
      phone: safeStr(body.user_phone) || distPayload.mobile || null,
      password_hash,
      role: "distributor",
      is_active: true,
      // distributor_id will be set after distributor is created
    };

    // 1) create distributor
    const dist = await Distributor.create(distPayload, { transaction: t });

    // 2) create linked user
    const user = await User.create(
      { ...userPayload, distributor_id: dist.id },
      { transaction: t }
    );

    await t.commit();

    // return temp password only at creation time
    return reply.send({
      message: "Distributor + User created",
      distributor: dist,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        distributor_id: user.distributor_id,
      },
      temp_password: password,
    });
  } catch (err) {
    request.log.error(err);
    try {
      await t.rollback();
    } catch (_) {}
    return reply.code(500).send({ message: "Internal Server Error" });
  }
}

/* ---------------- UPDATE ---------------- */

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

/* ---------------- REMOVE (SOFT) ---------------- */

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

module.exports = { list, create, createWithUser, update, remove };
