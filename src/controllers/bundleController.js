"use strict";

const { Op } = require("sequelize");

const {
  Bundle,
  BundleItem,
  School,
  Book,
  InventoryBatch,
  InventoryTxn,
  sequelize,
} = require("../models");

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function getAvailableMap(t) {
  const rows = await InventoryBatch.findAll({
    attributes: [
      "book_id",
      [sequelize.fn("SUM", sequelize.col("available_qty")), "available_qty"],
    ],
    group: ["book_id"],
    raw: true,
    transaction: t,
  });

  const map = new Map();
  rows.forEach((r) => map.set(Number(r.book_id), num(r.available_qty)));
  return map;
}

async function getReservedMapForBundles(t) {
  // Reserved for bundles = RESERVE - UNRESERVE where ref_type = BUNDLE
  const rows = await InventoryTxn.findAll({
    where: { ref_type: "BUNDLE" },
    attributes: [
      "book_id",
      [
        sequelize.literal(`
          SUM(CASE WHEN txn_type='RESERVE' THEN qty ELSE 0 END) -
          SUM(CASE WHEN txn_type='UNRESERVE' THEN qty ELSE 0 END)
        `),
        "reserved_qty",
      ],
    ],
    group: ["book_id"],
    raw: true,
    transaction: t,
  });

  const map = new Map();
  rows.forEach((r) => map.set(Number(r.book_id), Math.max(0, num(r.reserved_qty))));
  return map;
}

/* =========================================================
   POST /api/bundles
   Create bundle + reserve items (NO stock deduction)
   Body: { schoolId, academic_session, notes, items:[{book_id, qty}] }
   ========================================================= */
exports.createBundle = async (request, reply) => {
  const body = request.body || {};
  const schoolId = num(body.schoolId);
  const academic_session = String(body.academic_session || "").trim();
  const notes = body.notes ? String(body.notes).trim() : null;
  const items = Array.isArray(body.items) ? body.items : [];

  if (!schoolId) return reply.code(400).send({ message: "schoolId is required" });
  if (!academic_session) return reply.code(400).send({ message: "academic_session is required" });
  if (!items.length) return reply.code(400).send({ message: "items are required" });

  // ✅ sanitize items (aggregate same book_id)
  const agg = new Map();
  for (const it of items) {
    const book_id = num(it.book_id);
    const qty = Math.max(0, num(it.qty)); // incoming still "qty" from frontend
    if (!book_id || qty <= 0) continue;

    agg.set(book_id, (agg.get(book_id) || 0) + qty);
  }

  const cleanItems = Array.from(agg.entries()).map(([book_id, qty]) => ({
    book_id,
    required_qty: qty, // ✅ DB column
  }));

  if (!cleanItems.length) return reply.code(400).send({ message: "valid items are required" });

  const t = await sequelize.transaction();
  try {
    const school = await School.findByPk(schoolId, { transaction: t });
    if (!school) {
      await t.rollback();
      return reply.code(404).send({ message: "School not found" });
    }

    // validate books exist
    const bookIds = cleanItems.map((x) => x.book_id);
    const books = await Book.findAll({
      where: { id: { [Op.in]: bookIds } },
      attributes: ["id", "title"],
      raw: true,
      transaction: t,
    });

    const bookSet = new Set(books.map((b) => Number(b.id)));
    const missing = bookIds.filter((id) => !bookSet.has(Number(id)));
    if (missing.length) {
      await t.rollback();
      return reply.code(400).send({ message: `Invalid book_id(s): ${missing.join(", ")}` });
    }

    // compute free stock (global available - bundle reserved)
    const availableMap = await getAvailableMap(t);
    const reservedMap = await getReservedMapForBundles(t);

    const shortages = [];
    for (const it of cleanItems) {
      const avl = availableMap.get(it.book_id) || 0;
      const res = reservedMap.get(it.book_id) || 0;
      const free = Math.max(0, avl - res);

      if (free < it.required_qty) {
        shortages.push({
          book_id: it.book_id,
          requested: it.required_qty,
          free,
          shortBy: it.required_qty - free,
        });
      }
    }

    if (shortages.length) {
      await t.rollback();
      return reply.code(400).send({
        message: "Insufficient free stock for some books",
        shortages,
      });
    }

    // create bundle
    const bundle = await Bundle.create(
      {
        school_id: schoolId,
        academic_session,
        status: "RESERVED",
        notes,
      },
      { transaction: t }
    );

    // create bundle items ✅ using new columns
    const bundleItemsPayload = cleanItems.map((it) => ({
      bundle_id: bundle.id,
      book_id: it.book_id,
      required_qty: it.required_qty,
      reserved_qty: it.required_qty, // ✅ reserve same as required at creation
      issued_qty: 0,
    }));

    await BundleItem.bulkCreate(bundleItemsPayload, { transaction: t });

    // create RESERVE txns (reserve required_qty)
    const txnPayload = cleanItems.map((it) => ({
      txn_type: "RESERVE",
      book_id: it.book_id,
      batch_id: null,
      qty: it.required_qty,
      ref_type: "BUNDLE",
      ref_id: bundle.id,
      notes: `Reserve for bundle #${bundle.id} (school ${schoolId}, ${academic_session})`,
    }));

    await InventoryTxn.bulkCreate(txnPayload, { transaction: t });

    await t.commit();

    return reply.send({
      message: "Bundle created & stock reserved",
      bundle: {
        id: bundle.id,
        school_id: bundle.school_id,
        academic_session: bundle.academic_session,
        status: bundle.status,
        notes: bundle.notes,
      },
      items: bundleItemsPayload,
    });
  } catch (err) {
    request.log.error(err);
    await t.rollback();
    return reply.code(500).send({ message: "Internal Server Error" });
  }
};

/* =========================================================
   GET /api/bundles?schoolId=&academic_session=&status=
   List bundles (with items)
   ========================================================= */
exports.listBundles = async (request, reply) => {
  try {
    const { schoolId, academic_session, status } = request.query || {};
    const where = {};
    if (schoolId) where.school_id = num(schoolId);
    if (academic_session) where.academic_session = String(academic_session);
    if (status) where.status = String(status);

    const rows = await Bundle.findAll({
      where,
      include: [
        { model: School, as: "school", attributes: ["id", "name"] },
        {
          model: BundleItem,
          as: "items",
          include: [{ model: Book, as: "book", attributes: ["id", "title"] }],
        },
      ],
      order: [["id", "DESC"]],
    });

    return reply.send({ rows });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ message: "Internal Server Error" });
  }
};

/* =========================================================
   POST /api/bundles/:id/cancel
   Cancel bundle + UNRESERVE txns
   ========================================================= */
exports.cancelBundle = async (request, reply) => {
  const bundleId = num(request.params?.id);
  if (!bundleId) return reply.code(400).send({ message: "Invalid bundle id" });

  const t = await sequelize.transaction();
  try {
    const bundle = await Bundle.findByPk(bundleId, {
      include: [{ model: BundleItem, as: "items" }],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!bundle) {
      await t.rollback();
      return reply.code(404).send({ message: "Bundle not found" });
    }

    if (bundle.status === "CANCELLED") {
      await t.rollback();
      return reply.send({ message: "Already cancelled", bundleId });
    }

    // ✅ don’t allow cancel once issued/dispatched/delivered
    if (["ISSUED", "DISPATCHED", "DELIVERED"].includes(bundle.status)) {
      await t.rollback();
      return reply.code(400).send({ message: `Cannot cancel a ${bundle.status} bundle` });
    }

    const items = (bundle.items || []).map((it) => ({
      book_id: num(it.book_id),
      reserved_qty: num(it.reserved_qty), // ✅ new column
    }));

    const toUnreserve = items.filter((x) => x.book_id && x.reserved_qty > 0);

    if (toUnreserve.length) {
      const txnPayload = toUnreserve.map((it) => ({
        txn_type: "UNRESERVE",
        book_id: it.book_id,
        batch_id: null,
        qty: it.reserved_qty,
        ref_type: "BUNDLE",
        ref_id: bundle.id,
        notes: `Unreserve for cancelled bundle #${bundle.id}`,
      }));
      await InventoryTxn.bulkCreate(txnPayload, { transaction: t });
    }

    // also zero reserved_qty in bundle_items (optional but clean)
    if (bundle.items?.length) {
      for (const it of bundle.items) {
        await it.update({ reserved_qty: 0 }, { transaction: t });
      }
    }

    await bundle.update({ status: "CANCELLED" }, { transaction: t });
    await t.commit();

    return reply.send({ message: "Bundle cancelled & stock unreserved", bundleId });
  } catch (err) {
    request.log.error(err);
    await t.rollback();
    return reply.code(500).send({ message: "Internal Server Error" });
  }
};
