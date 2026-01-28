"use strict";

const { Op } = require("sequelize");
const { Product, Book, BundleItem, sequelize } = require("../models");

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

const normalizeType = (v) => {
  const t = String(v || "").trim().toUpperCase();
  return t === "BOOK" || t === "MATERIAL" ? t : null;
};

async function ensureProductExists(id) {
  const row = await Product.findByPk(id);
  if (!row) {
    const err = new Error("Product not found");
    err.statusCode = 404;
    throw err;
  }
  return row;
}

async function validatePayloadForCreateOrUpdate(payload, { isCreate }) {
  // type
  if (isCreate) {
    if (!payload.type) {
      const err = new Error("type is required");
      err.statusCode = 400;
      throw err;
    }
  }

  if (payload.type !== undefined) {
    const t = normalizeType(payload.type);
    if (!t) {
      const err = new Error('type must be "BOOK" or "MATERIAL"');
      err.statusCode = 400;
      throw err;
    }
    payload.type = t;
  }

  // Normalize common fields
  if (payload.uom !== undefined) payload.uom = payload.uom == null ? null : String(payload.uom).trim();
  if (payload.is_active !== undefined) payload.is_active = bool(payload.is_active);

  if (payload.book_id !== undefined) payload.book_id = payload.book_id == null ? null : num(payload.book_id);
  if (payload.name !== undefined) payload.name = payload.name == null ? null : String(payload.name).trim();

  // Validate by type (if type known for this request)
  const t = payload.type; // may be undefined on update
  if (t === "BOOK") {
    if (!payload.book_id) {
      const err = new Error("book_id is required when type=BOOK");
      err.statusCode = 400;
      throw err;
    }
    // For BOOK: keep name null (optional but recommended)
    payload.name = null;

    // ensure book exists (if Book model available)
    if (Book) {
      const b = await Book.findByPk(payload.book_id, { attributes: ["id"] });
      if (!b) {
        const err = new Error("Invalid book_id");
        err.statusCode = 400;
        throw err;
      }
    }
  }

  if (t === "MATERIAL") {
    if (!payload.name) {
      const err = new Error("name is required when type=MATERIAL");
      err.statusCode = 400;
      throw err;
    }
    // For MATERIAL: book_id must be null
    payload.book_id = null;
  }

  // If update request does NOT include type, we cannot validate cross-field combos fully here.
  // We'll handle that in updateProduct by reading existing row type.
}

module.exports = {
  // ======================================================
  // GET /api/products
  // query: type?, book_id?, is_active?, q?, include_book?
  // ======================================================
  async listProducts(req, reply) {
    const q = req.query || {};
    const where = {};

    if (q.type) {
      const t = normalizeType(q.type);
      if (!t) return reply.code(400).send({ success: false, message: 'type must be "BOOK" or "MATERIAL"' });
      where.type = t;
    }

    if (q.book_id) where.book_id = num(q.book_id);
    if (q.is_active !== undefined) where.is_active = bool(q.is_active);

    // search (for MATERIAL name OR Book title)
    const search = String(q.q || "").trim();
    const includeBook = bool(q.include_book);

    const include = [];
    if (includeBook && Book) {
      include.push({
        model: Book,
        as: "book",
        required: false,
        attributes: ["id", "title", "class_name"],
      });
    }

    // If search term is present, search:
    // - MATERIAL: products.name like
    // - BOOK: book.title like (requires include Book)
    if (search) {
      const like = `%${search}%`;

      if (includeBook && Book) {
        // include Book and search across both
        include[0].where = {
          [Op.or]: [{ title: { [Op.like]: like } }],
        };
        include[0].required = false;

        where[Op.or] = [
          { name: { [Op.like]: like } }, // material
          { type: "BOOK" }, // allow book rows; filtering by include.where does the title match
        ];
      } else {
        // no include book: only material name search
        where.name = { [Op.like]: like };
      }
    }

    const rows = await Product.findAll({
      where,
      order: [
        ["type", "ASC"],
        ["id", "DESC"],
      ],
      include,
    });

    return reply.send({ success: true, data: rows });
  },

  // ======================================================
  // GET /api/products/:id
  // ======================================================
  async getProductById(req, reply) {
    const id = num(req.params.id);

    const row = await Product.findByPk(id, {
      include: Book
        ? [{ model: Book, as: "book", required: false, attributes: ["id", "title", "class_name"] }]
        : [],
    });

    if (!row) return reply.code(404).send({ success: false, message: "Product not found" });
    return reply.send({ success: true, data: row });
  },

  // ======================================================
  // POST /api/products
  // body: { type, book_id?, name?, uom?, is_active? }
  // ======================================================
  async createProduct(req, reply) {
    const b = req.body || {};

    const payload = {
      type: normalizeType(b.type),
      book_id: b.book_id == null ? null : num(b.book_id),
      name: b.name == null ? null : String(b.name).trim(),
      uom: b.uom == null ? "PCS" : String(b.uom).trim(),
      is_active: b.is_active === undefined ? true : bool(b.is_active),
    };

    try {
      await validatePayloadForCreateOrUpdate(payload, { isCreate: true });
      const row = await Product.create(payload);
      return reply.code(201).send({ success: true, data: row });
    } catch (err) {
      const status = err.statusCode || 400;

      // handle unique constraint nicely (type + book_id)
      if (String(err.name || "").includes("SequelizeUniqueConstraintError")) {
        return reply.code(409).send({
          success: false,
          message: "Duplicate product (type + book_id) already exists",
        });
      }

      return reply.code(status).send({ success: false, message: err.message || "Invalid request" });
    }
  },

  // ======================================================
  // PUT /api/products/:id
  // body: { type?, book_id?, name?, uom?, is_active? }
  // ======================================================
  async updateProduct(req, reply) {
    const id = num(req.params.id);
    const b = req.body || {};

    const row = await ensureProductExists(id);

    const changes = pick(b, ["type", "book_id", "name", "uom", "is_active"]);

    // Normalize fields (without enforcing type rules yet)
    if (changes.type !== undefined) changes.type = normalizeType(changes.type);
    if (changes.book_id !== undefined) changes.book_id = changes.book_id == null ? null : num(changes.book_id);
    if (changes.name !== undefined) changes.name = changes.name == null ? null : String(changes.name).trim();
    if (changes.uom !== undefined) changes.uom = changes.uom == null ? null : String(changes.uom).trim();
    if (changes.is_active !== undefined) changes.is_active = bool(changes.is_active);

    // Determine effective type (existing or updated)
    const effectiveType = changes.type || row.type;

    // Build a payload to validate *as if final*
    const finalPayload = {
      type: effectiveType,
      book_id: changes.book_id !== undefined ? changes.book_id : row.book_id,
      name: changes.name !== undefined ? changes.name : row.name,
      uom: changes.uom !== undefined ? changes.uom : row.uom,
      is_active: changes.is_active !== undefined ? changes.is_active : row.is_active,
    };

    try {
      await validatePayloadForCreateOrUpdate(finalPayload, { isCreate: false });

      // Apply type-based cleanup
      if (effectiveType === "BOOK") {
        changes.type = "BOOK";
        // must have book_id
        if (changes.book_id === undefined) changes.book_id = finalPayload.book_id;
        // force name null
        changes.name = null;
      } else if (effectiveType === "MATERIAL") {
        changes.type = "MATERIAL";
        // force book_id null
        changes.book_id = null;
        // must have name
        if (changes.name === undefined) changes.name = finalPayload.name;
      }

      await row.update(changes);

      // return with optional book
      const fresh = await Product.findByPk(row.id, {
        include: Book
          ? [{ model: Book, as: "book", required: false, attributes: ["id", "title", "class_name"] }]
          : [],
      });

      return reply.send({ success: true, data: fresh });
    } catch (err) {
      const status = err.statusCode || 400;

      if (String(err.name || "").includes("SequelizeUniqueConstraintError")) {
        return reply.code(409).send({
          success: false,
          message: "Duplicate product (type + book_id) already exists",
        });
      }

      return reply.code(status).send({ success: false, message: err.message || "Invalid request" });
    }
  },

  // ======================================================
  // DELETE /api/products/:id
  // Block delete if referenced by BundleItem
  // ======================================================
  async deleteProduct(req, reply) {
    const id = num(req.params.id);
    const row = await ensureProductExists(id);

    // If bundle system exists: block delete if used
    if (BundleItem) {
      const used = await BundleItem.count({ where: { product_id: id } });
      if (used > 0) {
        return reply.code(400).send({
          success: false,
          message: "Product is used in bundles. Remove it from bundles first.",
        });
      }
    }

    await row.destroy();
    return reply.send({ success: true, message: "Product deleted" });
  },
};
