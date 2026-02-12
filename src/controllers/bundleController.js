"use strict";

const { Op } = require("sequelize");
const {
  Bundle,
  BundleItem,
  Product,
  School,
  Book,
  Class,
  SchoolBookRequirement, // ✅ ADDED (for default qty)
  ProductCategory, // ✅ NEW (category include)
  sequelize,
} = require("../models");

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

async function ensureBundleExists(id) {
  const bundle = await Bundle.findByPk(id);
  if (!bundle) {
    const err = new Error("Bundle not found");
    err.statusCode = 404;
    throw err;
  }
  return bundle;
}

/**
 * ✅ Product include builder (Book + Category)
 * - Uses association if present
 * - Fallback to model+as if association not registered
 */
function buildProductIncludes() {
  const inc = [];

  // book
  if (Product?.associations?.book) {
    inc.push({
      association: Product.associations.book,
      required: false,
      attributes: ["id", "title", "class_name", "rate", "mrp"],
    });
  } else if (Book) {
    inc.push({
      model: Book,
      as: "book",
      required: false,
      attributes: ["id", "title", "class_name", "rate", "mrp"],
    });
  }

  // category
  if (Product?.associations?.category) {
    inc.push({
      association: Product.associations.category,
      required: false,
      attributes: ["id", "name"],
    });
  } else if (ProductCategory) {
    // must match: Product.belongsTo(ProductCategory, { as:"category", foreignKey:"category_id" })
    inc.push({
      model: ProductCategory,
      as: "category",
      required: false,
      attributes: ["id", "name"],
    });
  }

  return inc;
}

/**
 * ✅ Bundle include builder (items -> product -> book+category)
 */
function buildBundleItemsInclude() {
  return [
    {
      model: BundleItem,
      as: "items",
      required: false,
      include: [
        {
          model: Product,
          as: "product",
          required: false,
          include: buildProductIncludes(),
        },
      ],
      // NOTE: ordering of nested include is handled in query "order" below
    },
  ];
}

module.exports = {
  // ======================================================
  // GET /api/bundles
  // ======================================================
  async listBundles(req, reply) {
    const q = req.query || {};

    const where = {};
    if (q.school_id) where.school_id = num(q.school_id);
    if (q.class_id) where.class_id = num(q.class_id);
    if (q.class_name) where.class_name = String(q.class_name).trim();
    if (q.academic_session) where.academic_session = String(q.academic_session).trim();
    if (q.is_active !== undefined) where.is_active = bool(q.is_active);

    const rows = await Bundle.findAll({
      where,
      order: [
        ["sort_order", "ASC"],
        ["id", "DESC"],
      ],
      include: [
        { model: School, as: "school", required: false, attributes: ["id", "name"] },
        Class ? { model: Class, as: "class", required: false, attributes: ["id", "class_name"] } : null,
      ].filter(Boolean),
    });

    return reply.send({ success: true, data: rows });
  },

  // ======================================================
  // GET /api/bundles/:id
  // ✅ UPDATED: items -> product -> book + category
  // ======================================================
  async getBundleById(req, reply) {
    const id = num(req.params.id);

    const bundle = await Bundle.findByPk(id, {
      include: [
        { model: School, as: "school", required: false, attributes: ["id", "name"] },
        Class ? { model: Class, as: "class", required: false, attributes: ["id", "class_name"] } : null,
        ...buildBundleItemsInclude(),
      ].filter(Boolean),
      order: [
        [{ model: BundleItem, as: "items" }, "sort_order", "ASC"],
        [{ model: BundleItem, as: "items" }, "id", "ASC"],
      ],
    });

    if (!bundle) return reply.code(404).send({ success: false, message: "Bundle not found" });

    return reply.send({ success: true, data: bundle });
  },

  // ======================================================
  // POST /api/bundles
  // body: { school_id, class_id?, class_name?, academic_session?, name, is_active?, sort_order? }
  // ======================================================
  async createBundle(req, reply) {
    const b = req.body || {};

    const payload = {
      school_id: num(b.school_id),
      class_id: b.class_id == null ? null : num(b.class_id),
      class_name: b.class_name == null ? null : String(b.class_name).trim(),
      academic_session: b.academic_session == null ? null : String(b.academic_session).trim(),
      name: String(b.name || "").trim(),
      is_active: b.is_active === undefined ? true : bool(b.is_active),
      sort_order: b.sort_order === undefined ? 0 : num(b.sort_order),
    };

    if (!payload.school_id) {
      return reply.code(400).send({ success: false, message: "school_id is required" });
    }
    if (!payload.name) {
      return reply.code(400).send({ success: false, message: "name is required" });
    }

    // optional: ensure school exists
    const school = await School.findByPk(payload.school_id);
    if (!school) return reply.code(400).send({ success: false, message: "Invalid school_id" });

    const row = await Bundle.create(payload);
    return reply.code(201).send({ success: true, data: row });
  },

  // ======================================================
  // PUT /api/bundles/:id
  // ======================================================
  async updateBundle(req, reply) {
    const id = num(req.params.id);
    const b = req.body || {};

    const bundle = await ensureBundleExists(id);

    const changes = pick(b, [
      "school_id",
      "class_id",
      "class_name",
      "academic_session",
      "name",
      "is_active",
      "sort_order",
    ]);

    if (changes.school_id !== undefined) changes.school_id = num(changes.school_id);
    if (changes.class_id !== undefined) changes.class_id = changes.class_id == null ? null : num(changes.class_id);
    if (changes.class_name !== undefined)
      changes.class_name = changes.class_name == null ? null : String(changes.class_name).trim();
    if (changes.academic_session !== undefined)
      changes.academic_session = changes.academic_session == null ? null : String(changes.academic_session).trim();
    if (changes.name !== undefined) changes.name = String(changes.name || "").trim();
    if (changes.is_active !== undefined) changes.is_active = bool(changes.is_active);
    if (changes.sort_order !== undefined) changes.sort_order = num(changes.sort_order);

    if (changes.school_id) {
      const school = await School.findByPk(changes.school_id);
      if (!school) return reply.code(400).send({ success: false, message: "Invalid school_id" });
    }

    if (changes.name !== undefined && !changes.name) {
      return reply.code(400).send({ success: false, message: "name cannot be empty" });
    }

    await bundle.update(changes);
    return reply.send({ success: true, data: bundle });
  },

  // ======================================================
  // DELETE /api/bundles/:id
  // ======================================================
  async deleteBundle(req, reply) {
    const id = num(req.params.id);
    const bundle = await ensureBundleExists(id);

    await bundle.destroy();
    return reply.send({ success: true, message: "Bundle deleted" });
  },

  // ======================================================
  // POST /api/bundles/:id/items
  // Upsert items, optionally replace
  // ======================================================
  async upsertBundleItems(req, reply) {
    const bundleId = num(req.params.id);
    const body = req.body || {};
    const replace = bool(body.replace);
    const items = Array.isArray(body.items) ? body.items : [];

    const useDefaults = bool(body.use_defaults);
    const overwriteQty = bool(body.overwrite_qty);
    const overwritePerStudentQty = bool(body.overwrite_per_student_qty);
    const overwritePrice = bool(body.overwrite_price);
    const bundleType = String(body.bundle_type || "SCHOOL_BULK").trim().toUpperCase(); // SCHOOL_BULK | STUDENT

    if (!items.length) {
      return reply.code(400).send({ success: false, message: "items[] is required" });
    }

    // Need full bundle (school_id/class_id/session) for requirements
    const bundle = await Bundle.findByPk(bundleId);
    if (!bundle) return reply.code(404).send({ success: false, message: "Bundle not found" });

    const academicSession =
      body.academic_session != null && String(body.academic_session).trim()
        ? String(body.academic_session).trim()
        : bundle.academic_session
        ? String(bundle.academic_session).trim()
        : null;

    // Normalize and basic validate
    let normalized = items.map((it) => ({
      id: it.id ? num(it.id) : null,
      product_id: num(it.product_id),

      // ✅ TOTAL qty
      qty: it.qty === undefined ? 1 : Math.max(0, num(it.qty)),

      // ✅ per student qty (default 1)
      per_student_qty: it.per_student_qty === undefined ? 1 : Math.max(0, num(it.per_student_qty)),

      mrp: it.mrp === undefined ? 0 : num(it.mrp),
      sale_price: it.sale_price === undefined ? 0 : num(it.sale_price),

      is_optional: it.is_optional === undefined ? false : bool(it.is_optional),
      sort_order: it.sort_order === undefined ? 0 : num(it.sort_order),
    }));

    for (const it of normalized) {
      if (!it.product_id) {
        return reply.code(400).send({ success: false, message: "product_id is required for all items" });
      }
    }

    // Ensure all products exist
    const productIds = [...new Set(normalized.map((x) => x.product_id))];
    const products = await Product.findAll({
      where: { id: { [Op.in]: productIds } },
      attributes: ["id", "type", "book_id", "name", "is_active", "category_id"],
    });

    if (products.length !== productIds.length) {
      return reply.code(400).send({ success: false, message: "One or more product_id are invalid" });
    }

    const productById = new Map(products.map((p) => [p.id, p]));

    /* ======================================================
       ✅ Defaults:
       - per_student_qty: STUDENT => 1 (if overwrite_per_student_qty)
       - qty (TOTAL): SCHOOL_BULK => requirement required_copies (BOOK only) (if overwrite_qty)
       - price: from Book (if overwrite_price)
       ====================================================== */
    if (useDefaults) {
      // ✅ per-student defaults apply to ALL items (BOOK/MATERIAL)
      if (bundleType === "STUDENT" && overwritePerStudentQty) {
        normalized = normalized.map((it) => ({ ...it, per_student_qty: 1 }));
      }

      // only BOOK products can map to requirements + book pricing
      const bookProducts = products.filter((p) => String(p.type || "").toUpperCase() === "BOOK" && p.book_id);
      const bookIds = [...new Set(bookProducts.map((p) => num(p.book_id)))];

      // Books for price defaults
      const books = bookIds.length
        ? await Book.findAll({
            where: { id: { [Op.in]: bookIds } },
            attributes: ["id", "mrp", "rate", "selling_price"],
          })
        : [];
      const bookById = new Map(books.map((b) => [num(b.id), b]));

      // Requirements for TOTAL qty defaults (SCHOOL_BULK only)
      let reqByBookId = new Map(); // book_id -> required_copies
      if (bundle.school_id && academicSession) {
        const reqWhere = {
          school_id: num(bundle.school_id),
          academic_session: academicSession,
        };
        if (bundle.class_id) reqWhere.class_id = num(bundle.class_id);

        const reqRows = await SchoolBookRequirement.findAll({
          where: reqWhere,
          attributes: ["book_id", "required_copies"],
        });

        reqByBookId = new Map(reqRows.map((r) => [num(r.book_id), num(r.required_copies)]));
      }

      const pickSalePrice = (bookRow) => {
        if (!bookRow) return 0;
        const r = num(bookRow.rate);
        if (r > 0) return r;
        const sp = num(bookRow.selling_price);
        if (sp > 0) return sp;
        const mrp = num(bookRow.mrp);
        return mrp > 0 ? mrp : 0;
      };

      normalized = normalized.map((it) => {
        const p = productById.get(it.product_id);
        if (!p || String(p.type || "").toUpperCase() !== "BOOK" || !p.book_id) return it;

        const bookId = num(p.book_id);
        const bookRow = bookById.get(bookId);

        // ✅ TOTAL qty default
        let defaultTotalQty = it.qty;
        if (bundleType === "SCHOOL_BULK") {
          const reqQty = reqByBookId.get(bookId);
          if (Number.isFinite(reqQty) && reqQty >= 0) defaultTotalQty = reqQty;
        }

        const defaultPrice = pickSalePrice(bookRow);
        const defaultMrp = bookRow ? num(bookRow.mrp) : it.mrp;

        return {
          ...it,
          qty: overwriteQty ? defaultTotalQty : it.qty,
          sale_price: overwritePrice ? defaultPrice : it.sale_price,
          mrp: overwritePrice ? defaultMrp : it.mrp,
        };
      });
    }

    // Transaction: upsert + optional replace delete
    const result = await sequelize.transaction(async (t) => {
      const existing = await BundleItem.findAll({
        where: { bundle_id: bundleId },
        transaction: t,
      });

      const existingById = new Map(existing.map((x) => [x.id, x]));
      const existingByProduct = new Map(existing.map((x) => [x.product_id, x]));

      const keptIds = new Set();

      for (const it of normalized) {
        // Update by id if provided
        if (it.id) {
          const row = existingById.get(it.id);
          if (!row) {
            throw Object.assign(new Error(`BundleItem not found: ${it.id}`), { statusCode: 404 });
          }
          if (row.bundle_id !== bundleId) {
            throw Object.assign(new Error("Invalid bundle item"), { statusCode: 400 });
          }

          await row.update(
            {
              product_id: it.product_id,
              qty: it.qty,
              per_student_qty: it.per_student_qty,
              mrp: it.mrp,
              sale_price: it.sale_price,
              is_optional: it.is_optional,
              sort_order: it.sort_order,
            },
            { transaction: t }
          );
          keptIds.add(row.id);
          continue;
        }

        // Else upsert by (bundle_id, product_id)
        const existingRow = existingByProduct.get(it.product_id);
        if (existingRow) {
          await existingRow.update(
            {
              qty: it.qty,
              per_student_qty: it.per_student_qty,
              mrp: it.mrp,
              sale_price: it.sale_price,
              is_optional: it.is_optional,
              sort_order: it.sort_order,
            },
            { transaction: t }
          );
          keptIds.add(existingRow.id);
        } else {
          const created = await BundleItem.create(
            {
              bundle_id: bundleId,
              product_id: it.product_id,
              qty: it.qty,
              per_student_qty: it.per_student_qty,
              mrp: it.mrp,
              sale_price: it.sale_price,
              is_optional: it.is_optional,
              sort_order: it.sort_order,
            },
            { transaction: t }
          );
          keptIds.add(created.id);
        }
      }

      if (replace) {
        const toDelete = existing.filter((x) => !keptIds.has(x.id));
        if (toDelete.length) {
          await BundleItem.destroy({
            where: { id: { [Op.in]: toDelete.map((x) => x.id) } },
            transaction: t,
          });
        }
      }

      // ✅ return fresh bundle with items (product->book+category)
      const fresh = await Bundle.findByPk(bundleId, {
        transaction: t,
        include: buildBundleItemsInclude(),
        order: [
          [{ model: BundleItem, as: "items" }, "sort_order", "ASC"],
          [{ model: BundleItem, as: "items" }, "id", "ASC"],
        ],
      });

      return fresh;
    });

    return reply.send({ success: true, data: result, bundle: bundleId });
  },

  // ======================================================
  // DELETE /api/bundles/:id/items/:itemId
  // ======================================================
  async deleteBundleItem(req, reply) {
    const bundleId = num(req.params.id);
    const itemId = num(req.params.itemId);

    await ensureBundleExists(bundleId);

    const row = await BundleItem.findByPk(itemId);
    if (!row) return reply.code(404).send({ success: false, message: "Bundle item not found" });
    if (row.bundle_id !== bundleId) return reply.code(400).send({ success: false, message: "Invalid bundle item" });

    await row.destroy();
    return reply.send({ success: true, message: "Bundle item deleted" });
  },
};
