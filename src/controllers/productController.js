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

  // ✅ NEW: category model (if present)
  ProductCategory,
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

const safeStr = (v) => String(v ?? "").trim();

const BOOK_ATTRS = ["id", "title", "subject", "code", "class_name", "rate", "selling_price", "mrp"];
const CAT_ATTRS = ["id", "name"];

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

  // ✅ category_id normalize
  if (payload.category_id !== undefined) payload.category_id = payload.category_id == null ? null : num(payload.category_id);

  const t = payload.type; // may be undefined on update

  if (t === "BOOK") {
    if (!payload.book_id) {
      const err = new Error("book_id is required when type=BOOK");
      err.statusCode = 400;
      throw err;
    }

    // For BOOK: force name null
    payload.name = null;

    // For BOOK: category optional (allow null)
    // payload.category_id is allowed or null

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

    // ✅ MATERIAL: category required (as per your model validate)
    if (!payload.category_id) {
      const err = new Error("category_id is required when type=MATERIAL");
      err.statusCode = 400;
      throw err;
    }

    // ✅ validate category exists (if model exists)
    if (ProductCategory) {
      const cat = await ProductCategory.findByPk(payload.category_id, { attributes: ["id"] });
      if (!cat) {
        const err = new Error("Invalid category_id");
        err.statusCode = 400;
        throw err;
      }
    }
  }
}

/**
 * Option-A helper:
 * ensure every Book has a corresponding Product row of type=BOOK.
 */
async function ensureBookProducts({ onlyActiveBooks = false } = {}) {
  if (!Book || !Product) return { created: 0 };

  const whereBook = {};
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
      category_id: 1, // ✅ keep null by default
      uom: "PCS",
      is_active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

  if (!toCreate.length) return { created: 0 };

  await Product.bulkCreate(toCreate, { ignoreDuplicates: true });
  return { created: toCreate.length };
}

/**
 * ✅ Find distinct book_ids from DIRECT purchases
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

  return [];
}

/**
 * ✅ ensure Product rows exist for direct-purchased books
 */
async function ensureProductsForBookIds(bookIds = []) {
  if (!Product || !Book) return { created: 0 };
  const ids = Array.from(new Set((bookIds || []).map(num).filter(Boolean)));
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
      category_id: null, // ✅ keep null
      uom: "PCS",
      is_active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

  if (!toCreate.length) return { created: 0 };

  await Product.bulkCreate(toCreate, { ignoreDuplicates: true });
  return { created: toCreate.length };
}

/* =========================
 * Controller
 * ========================= */

module.exports = {
  // ======================================================
  // GET /api/products
  //
  // ✅ section support
  //   - section=books   => BOOK products only from Requirements
  //   - section=extras  => ONLY direct purchases (MATERIAL + direct-purchased BOOKs)
  //
  // ✅ category support
  //   - category_id=5
  //   - category_ids=1,2,3
  //   - include_category=1
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

    // ✅ category filters (works for MATERIAL mainly, but also allow for BOOK if you set it)
    const category_id = num(q.category_id);
    const category_ids = safeStr(q.category_ids);
    const catIdsArr = category_ids
      ? category_ids
          .split(",")
          .map((x) => num(x))
          .filter(Boolean)
      : [];

    if (category_id) where.category_id = category_id;
    if (catIdsArr.length) where.category_id = { [Op.in]: catIdsArr };

    const search = String(q.q || "").trim();
    const includeBook = bool(q.include_book);

    // ✅ include category?
    const includeCategory = bool(q.include_category);

    const include = [];

    if (includeBook && Book) {
      include.push({
        model: Book,
        as: "book",
        required: false,
        attributes: BOOK_ATTRS,
      });
    }

    if (includeCategory && ProductCategory) {
      include.push({
        model: ProductCategory,
        as: "category",
        required: false,
        attributes: CAT_ATTRS,
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

      if (search) {
        const like = `%${search}%`;

        // Search across book fields (and optionally category name if included)
        const ors = [];
        if (includeBook && Book) {
          ors.push(
            { "$book.title$": { [Op.like]: like } },
            { "$book.code$": { [Op.like]: like } },
            { "$book.subject$": { [Op.like]: like } },
            { "$book.class_name$": { [Op.like]: like } }
          );
        }
        if (includeCategory && ProductCategory) {
          ors.push({ "$category.name$": { [Op.like]: like } });
        }

        if (ors.length) {
          where[Op.and] = [...(where[Op.and] || []), { [Op.or]: ors }];
        }
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
    // - BOOK products included only if purchased directly
    // ======================================================
    if (section === "extras") {
      const onlyReceived = bool(q.only_received);

      const directBookIds = await findDirectPurchaseBookIds({ onlyReceived });

      const ensured = await ensureProductsForBookIds(directBookIds);

      const extrasWhere = {
        ...where,
        [Op.or]: [
          { type: "MATERIAL" },
          { type: "BOOK", book_id: { [Op.in]: directBookIds.length ? directBookIds : [-1] } },
        ],
      };

      if (search) {
        const like = `%${search}%`;

        const ors = [
          { name: { [Op.like]: like } }, // MATERIAL name
        ];

        if (includeBook && Book) {
          ors.push(
            { "$book.title$": { [Op.like]: like } },
            { "$book.code$": { [Op.like]: like } },
            { "$book.subject$": { [Op.like]: like } },
            { "$book.class_name$": { [Op.like]: like } }
          );
        }

        if (includeCategory && ProductCategory) {
          ors.push({ "$category.name$": { [Op.like]: like } });
        }

        extrasWhere[Op.and] = [...(extrasWhere[Op.and] || []), { [Op.or]: ors }];
      }

      const rows = await Product.findAll({
        where: extrasWhere,
        order: [
          ["type", "ASC"],
          ["id", "DESC"],
        ],
        include,
      });

      return reply.send({
        success: true,
        section: "extras",
        ensured_books: ensureBooks ? true : undefined,
        ensured_direct_books: ensured?.created ? ensured.created : 0,
        data: rows,
      });
    }

    // ======================================================
    // ✅ DEFAULT list (old behavior)
    // ======================================================
    if (search) {
      const like = `%${search}%`;

      const ors = [{ name: { [Op.like]: like } }];

      if (includeBook && Book) {
        ors.push(
          { "$book.title$": { [Op.like]: like } },
          { "$book.code$": { [Op.like]: like } },
          { "$book.subject$": { [Op.like]: like } },
          { "$book.class_name$": { [Op.like]: like } }
        );
      }

      if (includeCategory && ProductCategory) {
        ors.push({ "$category.name$": { [Op.like]: like } });
      }

      where[Op.or] = ors;
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

    const include = [];

    if (Book) {
      include.push({
        model: Book,
        as: "book",
        required: false,
        attributes: BOOK_ATTRS,
      });
    }

    if (ProductCategory) {
      include.push({
        model: ProductCategory,
        as: "category",
        required: false,
        attributes: CAT_ATTRS,
      });
    }

    const row = await Product.findByPk(id, { include });

    if (!row) return reply.code(404).send({ success: false, message: "Product not found" });
    return reply.send({ success: true, data: row });
  },

  // ======================================================
  // POST /api/products
  // body: { type, book_id?, name?, uom?, is_active?, category_id? }
  // ======================================================
  async createProduct(req, reply) {
    const b = req.body || {};

    const payload = {
      type: normalizeType(b.type),
      book_id: b.book_id == null ? null : num(b.book_id),
      name: b.name == null ? null : String(b.name).trim(),
      category_id: b.category_id == null ? null : num(b.category_id), // ✅ NEW
      uom: b.uom == null ? "PCS" : String(b.uom).trim(),
      is_active: b.is_active === undefined ? true : bool(b.is_active),
    };

    try {
      await validatePayloadForCreateOrUpdate(payload, { isCreate: true });

      const row = await Product.create(payload);

      const include = [];
      if (Book) include.push({ model: Book, as: "book", required: false, attributes: BOOK_ATTRS });
      if (ProductCategory) include.push({ model: ProductCategory, as: "category", required: false, attributes: CAT_ATTRS });

      const fresh = await Product.findByPk(row.id, { include });

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
  // body: { type?, book_id?, name?, uom?, is_active?, category_id? }
  // ======================================================
  async updateProduct(req, reply) {
    const id = num(req.params.id);
    const b = req.body || {};

    const row = await ensureProductExists(id);

    const changes = pick(b, ["type", "book_id", "name", "uom", "is_active", "category_id"]); // ✅ NEW

    // Normalize fields
    if (changes.type !== undefined) changes.type = normalizeType(changes.type);
    if (changes.book_id !== undefined) changes.book_id = changes.book_id == null ? null : num(changes.book_id);
    if (changes.name !== undefined) changes.name = changes.name == null ? null : String(changes.name).trim();
    if (changes.uom !== undefined) changes.uom = changes.uom == null ? null : String(changes.uom).trim();
    if (changes.is_active !== undefined) changes.is_active = bool(changes.is_active);
    if (changes.category_id !== undefined) changes.category_id = changes.category_id == null ? null : num(changes.category_id);

    const effectiveType = changes.type || row.type;

    const finalPayload = {
      type: effectiveType,
      book_id: changes.book_id !== undefined ? changes.book_id : row.book_id,
      name: changes.name !== undefined ? changes.name : row.name,
      category_id: changes.category_id !== undefined ? changes.category_id : row.category_id,
      uom: changes.uom !== undefined ? changes.uom : row.uom,
      is_active: changes.is_active !== undefined ? changes.is_active : row.is_active,
    };

    try {
      await validatePayloadForCreateOrUpdate(finalPayload, { isCreate: false });

      // enforce by type
      if (effectiveType === "BOOK") {
        changes.type = "BOOK";
        if (changes.book_id === undefined) changes.book_id = finalPayload.book_id;
        changes.name = null;
        // category optional; keep as given
      } else if (effectiveType === "MATERIAL") {
        changes.type = "MATERIAL";
        changes.book_id = null;
        if (changes.name === undefined) changes.name = finalPayload.name;
        // category required; validated above
      }

      await row.update(changes);

      const include = [];
      if (Book) include.push({ model: Book, as: "book", required: false, attributes: BOOK_ATTRS });
      if (ProductCategory) include.push({ model: ProductCategory, as: "category", required: false, attributes: CAT_ATTRS });

      const fresh = await Product.findByPk(row.id, { include });

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
  // POST /api/products/ensure-books
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
