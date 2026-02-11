"use strict";

const { Op } = require("sequelize");
const { ProductCategory, Product } = require("../models");

/* =========================
 * Helpers
 * ========================= */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const bool = (v) => v === true || v === 1 || v === "1" || v === "true";

const pick = (obj, keys) => {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
};

async function ensureCategoryExists(id) {
  const row = await ProductCategory.findByPk(id);
  if (!row) {
    const err = new Error("Category not found");
    err.statusCode = 404;
    throw err;
  }
  return row;
}

function normalizeName(v) {
  const s = String(v ?? "").trim();
  return s || null;
}

function normalizeDesc(v) {
  const s = v == null ? null : String(v).trim();
  return s || null;
}

async function validatePayloadForCreateOrUpdate(payload, { isCreate }) {
  if (isCreate && !payload.name) {
    const err = new Error("name is required");
    err.statusCode = 400;
    throw err;
  }

  if (payload.name !== undefined) {
    payload.name = normalizeName(payload.name);
    if (!payload.name) {
      const err = new Error("name is required");
      err.statusCode = 400;
      throw err;
    }
  }

  if (payload.description !== undefined) payload.description = normalizeDesc(payload.description);
  if (payload.is_active !== undefined) payload.is_active = bool(payload.is_active);
}

/* =========================
 * Controller
 * ========================= */

module.exports = {
  // ======================================================
  // GET /api/product-categories
  // Query:
  //  - active=true|false
  //  - q=search
  //  - include_counts=1  (optional: adds products_count)
  // ======================================================
  async listCategories(req, reply) {
    const q = req.query || {};
    const where = {};

    if (q.active !== undefined) where.is_active = bool(q.active);

    const search = String(q.q || "").trim();
    if (search) {
      where.name = { [Op.like]: `%${search}%` };
    }

    const includeCounts = bool(q.include_counts);

    // Default list
    const rows = await ProductCategory.findAll({
      where,
      order: [
        ["name", "ASC"],
        ["id", "DESC"],
      ],
    });

    if (!includeCounts || !Product) {
      return reply.send({ success: true, data: rows });
    }

    // Optional product counts (safe, small extra queries)
    const ids = rows.map((r) => r.id);
    const counts = await Product.findAll({
      attributes: ["category_id", [Product.sequelize.fn("COUNT", Product.sequelize.col("id")), "cnt"]],
      where: { category_id: { [Op.in]: ids } },
      group: ["category_id"],
      raw: true,
    });

    const map = new Map(counts.map((r) => [num(r.category_id), num(r.cnt)]));
    const out = rows.map((r) => ({
      ...r.toJSON(),
      products_count: map.get(num(r.id)) || 0,
    }));

    return reply.send({ success: true, data: out });
  },

  // ======================================================
  // GET /api/product-categories/:id
  // ======================================================
  async getCategoryById(req, reply) {
    const id = num(req.params.id);
    const row = await ProductCategory.findByPk(id);
    if (!row) return reply.code(404).send({ success: false, message: "Category not found" });
    return reply.send({ success: true, data: row });
  },

  // ======================================================
  // POST /api/product-categories
  // body: { name, description?, is_active? }
  // ======================================================
  async createCategory(req, reply) {
    const b = req.body || {};

    const payload = {
      name: normalizeName(b.name),
      description: normalizeDesc(b.description),
      is_active: b.is_active === undefined ? true : bool(b.is_active),
    };

    try {
      await validatePayloadForCreateOrUpdate(payload, { isCreate: true });

      // Extra: prevent duplicates (case-insensitive best effort)
      const exists = await ProductCategory.findOne({
        where: { name: payload.name },
        attributes: ["id"],
      });
      if (exists) {
        return reply.code(409).send({ success: false, message: "Category name already exists" });
      }

      const row = await ProductCategory.create(payload);
      const fresh = await ProductCategory.findByPk(row.id);
      return reply.code(201).send({ success: true, data: fresh });
    } catch (err) {
      const status = err.statusCode || 400;

      if (String(err.name || "").includes("SequelizeUniqueConstraintError")) {
        return reply.code(409).send({ success: false, message: "Category name already exists" });
      }

      return reply.code(status).send({ success: false, message: err.message || "Invalid request" });
    }
  },

  // ======================================================
  // PUT /api/product-categories/:id
  // body: { name?, description?, is_active? }
  // ======================================================
  async updateCategory(req, reply) {
    const id = num(req.params.id);
    const b = req.body || {};

    const row = await ensureCategoryExists(id);

    const changes = pick(b, ["name", "description", "is_active"]);

    // normalize
    if (changes.name !== undefined) changes.name = normalizeName(changes.name);
    if (changes.description !== undefined) changes.description = normalizeDesc(changes.description);
    if (changes.is_active !== undefined) changes.is_active = bool(changes.is_active);

    const finalPayload = {
      name: changes.name !== undefined ? changes.name : row.name,
      description: changes.description !== undefined ? changes.description : row.description,
      is_active: changes.is_active !== undefined ? changes.is_active : row.is_active,
    };

    try {
      await validatePayloadForCreateOrUpdate(finalPayload, { isCreate: false });

      // if name changed -> check duplicate
      if (changes.name && changes.name !== row.name) {
        const dup = await ProductCategory.findOne({
          where: { name: changes.name, id: { [Op.ne]: id } },
          attributes: ["id"],
        });
        if (dup) {
          return reply.code(409).send({ success: false, message: "Category name already exists" });
        }
      }

      await row.update(changes);

      const fresh = await ProductCategory.findByPk(row.id);
      return reply.send({ success: true, data: fresh });
    } catch (err) {
      const status = err.statusCode || 400;

      if (String(err.name || "").includes("SequelizeUniqueConstraintError")) {
        return reply.code(409).send({ success: false, message: "Category name already exists" });
      }

      return reply.code(status).send({ success: false, message: err.message || "Invalid request" });
    }
  },

  // ======================================================
  // PATCH /api/product-categories/:id/toggle
  // Toggles is_active (quick enable/disable)
  // ======================================================
  async toggleCategory(req, reply) {
    const id = num(req.params.id);
    const row = await ensureCategoryExists(id);

    const next = !row.is_active;
    await row.update({ is_active: next });

    const fresh = await ProductCategory.findByPk(row.id);
    return reply.send({
      success: true,
      message: next ? "Category enabled" : "Category disabled",
      data: fresh,
    });
  },

  // ======================================================
  // DELETE /api/product-categories/:id
  // Safety:
  // - block if any Product uses it
  // ======================================================
  async deleteCategory(req, reply) {
    const id = num(req.params.id);
    const row = await ensureCategoryExists(id);

    if (Product) {
      const used = await Product.count({ where: { category_id: id } });
      if (used > 0) {
        return reply.code(400).send({
          success: false,
          message: "Category is used by products. Re-assign products first.",
        });
      }
    }

    await row.destroy();
    return reply.send({ success: true, message: "Category deleted" });
  },
};
