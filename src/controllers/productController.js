"use strict";

const { Op } = require("sequelize");
const {
  Product,
  Book,
  BundleItem,
  sequelize,

  // ✅ NEW (for section filters)
  SchoolBookRequirement,
  SupplierReceipt,
  SupplierReceiptItem,
} = require("../models");

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
  if (isCreate && !payload.type) {
    const err = new Error("type is required");
    err.statusCode = 400;
    throw err;
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
    // For BOOK: force name null
    payload.name = null;

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
    // For MATERIAL: force book_id null
    payload.book_id = null;
  }
}

/**
 * Option-A helper:
 * ensure every Book has a corresponding Product row of type=BOOK.
 * This makes kit builder show books automatically without manual product entry.
 */
async function ensureBookProducts({ onlyActiveBooks = false } = {}) {
  if (!Book || !Product) return { created: 0 };

  const whereBook = {};
  // If your Book table has is_active column you can enable this.
  if (onlyActiveBooks && Book.rawAttributes && Book.rawAttributes.is_active) {
    whereBook.is_active = true;
  }

  const books = await Book.findAll({
    where: whereBook,
    attributes: ["id"],
    raw: true,
  });

  if (!books.length) return { created: 0 };

  const ids = books.map((b) => num(b.id)).filter(Boolean);
  if (!ids.length) return { created: 0 };

  const existing = await Product.findAll({
    where: { type: "BOOK", book_id: { [Op.in]: ids } },
    attributes: ["book_id"],
    raw: true,
  });

  const have = new Set(existing.map((r) => num(r.book_id)).filter(Boolean));
  const toCreate = ids
    .filter((id) => !have.has(id))
    .map((book_id) => ({
      type: "BOOK",
      book_id,
      name: null,
      uom: "PCS",
      is_active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

  if (!toCreate.length) return { created: 0 };

  // bulkCreate with ignoreDuplicates for safety
  await Product.bulkCreate(toCreate, { ignoreDuplicates: true });

  return { created: toCreate.length };
}

/**
 * ✅ Helper: pick correct alias for SupplierReceipt include (depends on your association)
 * We'll try a few common ones to avoid breaking.
 */
async function findDirectPurchaseBookIds({ onlyReceived = false } = {}) {
  if (!SupplierReceipt || !SupplierReceiptItem) return [];

  const directReceiptWhere = {
    [Op.or]: [{ school_order_id: null }, { school_order_id: 0 }],
  };
  if (onlyReceived) directReceiptWhere.status = "received";

  const aliasesToTry = ["supplier_receipt", "supplierReceipt", "receipt"];

  for (const asName of aliasesToTry) {
    try {
      const rows = await SupplierReceiptItem.findAll({
        attributes: [[sequelize.fn("DISTINCT", sequelize.col("SupplierReceiptItem.book_id")), "book_id"]],
        include: [
          {
            model: SupplierReceipt,
            as: asName,
            required: true,
            attributes: [],
            where: directReceiptWhere,
          },
        ],
        raw: true,
      });

      return (rows || []).map((r) => num(r.book_id)).filter(Boolean);
    } catch (e) {
      // try next alias
    }
  }

  // If none of the aliases worked, return empty (safer than crashing)
  return [];
}

/* =========================
 * Controller
 * ========================= */

module.exports = {
  // ======================================================
  // GET /api/products
  //
  // ✅ NEW: section support
  //   - section=books   => BOOK products only from Requirements
  //   - section=extras  => ONLY direct purchases (MATERIAL + direct-purchased BOOKs)
  //
  // existing query:
  // type?, book_id?, is_active?, q?, include_book?, ensure_books?
  //
  // optional filters for section=books:
  // school_id?, academic_session?, status?
  //
  // optional for section=extras:
  // only_received=1
  // ======================================================
  async listProducts(req, reply) {
    const q = req.query || {};
    const section = String(q.section || "").trim().toLowerCase();

    const where = {};

    // ✅ Option A: auto create BOOK products for all books (still available)
    const ensureBooks = bool(q.ensure_books);
    if (ensureBooks) {
      await ensureBookProducts({ onlyActiveBooks: false });
    }

    // base filters (still supported)
    if (q.type) {
      const t = normalizeType(q.type);
      if (!t) return reply.code(400).send({ success: false, message: 'type must be "BOOK" or "MATERIAL"' });
      where.type = t;
    }

    if (q.book_id) where.book_id = num(q.book_id);
    if (q.is_active !== undefined) where.is_active = bool(q.is_active);

    const search = String(q.q || "").trim();
    const includeBook = bool(q.include_book);

    const include = [];
    if (includeBook && Book) {
      include.push({
        model: Book,
        as: "book",
        required: false,
        attributes: ["id", "title", "subject", "code", "class_name"],
      });
    }

    // ======================================================
    // ✅ section=books => from requirements only
    // ======================================================
    if (section === "books") {
      if (!SchoolBookRequirement) {
        return reply.code(400).send({ success: false, message: "SchoolBookRequirement model not available" });
      }

      const school_id = num(q.school_id ?? q.schoolId);
      const academic_session = q.academic_session ? String(q.academic_session).trim() : null;
      const reqStatus = q.status ? String(q.status).trim() : null;

      const reqWhere = {};
      if (school_id) reqWhere.school_id = school_id;
      if (academic_session) reqWhere.academic_session = academic_session;
      if (reqStatus) reqWhere.status = reqStatus;

      const reqRows = await SchoolBookRequirement.findAll({
        where: reqWhere,
        attributes: [[sequelize.fn("DISTINCT", sequelize.col("book_id")), "book_id"]],
        raw: true,
      });

      const reqBookIds = (reqRows || []).map((r) => num(r.book_id)).filter(Boolean);

      // Force to BOOK products matching those requirement book_ids
      where.type = "BOOK";
      where.book_id = { [Op.in]: reqBookIds.length ? reqBookIds : [-1] };

      if (search && includeBook && Book) {
        const like = `%${search}%`;
        where[Op.and] = [
          ...(where[Op.and] || []),
          {
            [Op.or]: [
              { "$book.title$": { [Op.like]: like } },
              { "$book.code$": { [Op.like]: like } },
              { "$book.subject$": { [Op.like]: like } },
              { "$book.class_name$": { [Op.like]: like } },
            ],
          },
        ];
      }

      const rows = await Product.findAll({
        where,
        order: [["id", "DESC"]],
        include,
      });

      return reply.send({
        success: true,
        section: "books",
        ensured_books: ensureBooks ? true : undefined,
        data: rows,
      });
    }

    // ======================================================
    // ✅ section=extras => only direct purchases
    // - MATERIAL products always included
    // - BOOK products included only if purchased directly (optional but useful)
    // ======================================================
    if (section === "extras") {
      const onlyReceived = bool(q.only_received);

      const directBookIds = await findDirectPurchaseBookIds({ onlyReceived });

      const extrasWhere = {
        ...where,
        [Op.or]: [
          { type: "MATERIAL" },
          { type: "BOOK", book_id: { [Op.in]: directBookIds.length ? directBookIds : [-1] } },
        ],
      };

      if (search) {
        const like = `%${search}%`;
        if (includeBook && Book) {
          extrasWhere[Op.and] = [
            ...(extrasWhere[Op.and] || []),
            {
              [Op.or]: [
                { name: { [Op.like]: like } }, // MATERIAL
                { "$book.title$": { [Op.like]: like } }, // BOOK (direct)
                { "$book.code$": { [Op.like]: like } },
                { "$book.subject$": { [Op.like]: like } },
                { "$book.class_name$": { [Op.like]: like } },
              ],
            },
          ];
        } else {
          // without book join, search only MATERIAL by name
          extrasWhere.name = { [Op.like]: like };
        }
      }

      const rows = await Product.findAll({
        where: extrasWhere,
        order: [
          ["type", "ASC"], // MATERIAL first (optional)
          ["id", "DESC"],
        ],
        include,
      });

      return reply.send({
        success: true,
        section: "extras",
        ensured_books: ensureBooks ? true : undefined,
        data: rows,
      });
    }

    // ======================================================
    // ✅ DEFAULT list (old behavior)
    // ======================================================
    if (search) {
      const like = `%${search}%`;

      if (includeBook && Book) {
        where[Op.or] = [
          { name: { [Op.like]: like } },
          { "$book.title$": { [Op.like]: like } },
          { "$book.code$": { [Op.like]: like } },
          { "$book.subject$": { [Op.like]: like } },
          { "$book.class_name$": { [Op.like]: like } },
        ];
      } else {
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

    return reply.send({
      success: true,
      ensured_books: ensureBooks ? true : undefined,
      data: rows,
    });
  },

  // ======================================================
  // GET /api/products/:id
  // ======================================================
  async getProductById(req, reply) {
    const id = num(req.params.id);

    const row = await Product.findByPk(id, {
      include: Book
        ? [
            {
              model: Book,
              as: "book",
              required: false,
              attributes: ["id", "title", "subject", "code", "class_name"],
            },
          ]
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

      const fresh = await Product.findByPk(row.id, {
        include: Book
          ? [
              {
                model: Book,
                as: "book",
                required: false,
                attributes: ["id", "title", "subject", "code", "class_name"],
              },
            ]
          : [],
      });

      return reply.code(201).send({ success: true, data: fresh });
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
        if (changes.book_id === undefined) changes.book_id = finalPayload.book_id;
        changes.name = null;
      } else if (effectiveType === "MATERIAL") {
        changes.type = "MATERIAL";
        changes.book_id = null;
        if (changes.name === undefined) changes.name = finalPayload.name;
      }

      await row.update(changes);

      const fresh = await Product.findByPk(row.id, {
        include: Book
          ? [
              {
                model: Book,
                as: "book",
                required: false,
                attributes: ["id", "title", "subject", "code", "class_name"],
              },
            ]
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

  // ======================================================
  // POST /api/products/ensure-books  (optional helper route)
  // Creates BOOK products for all books.
  // ======================================================
  async ensureBooks(req, reply) {
    try {
      const out = await ensureBookProducts({ onlyActiveBooks: false });
      return reply.send({ success: true, ...out });
    } catch (err) {
      return reply.code(500).send({ success: false, message: err.message || "Failed to ensure book products" });
    }
  },
};
