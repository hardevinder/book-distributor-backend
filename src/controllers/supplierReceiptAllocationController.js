// src/controllers/supplierReceiptAllocationController.js
"use strict";

const { Op } = require("sequelize");
const {
  sequelize,
  SupplierReceipt,
  SupplierReceiptItem,
  SupplierReceiptAllocation,
  InventoryBatch,
  InventoryTxn,
  School,
  Book,
} = require("../models");

/* ============================================================
 * Helpers (same style as your controller)
 * ============================================================ */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const asBool = (v) => {
  if (v === true || v === 1 || v === "1") return true;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "yes";
};

const safeText = (v) => String(v ?? "").trim();

function pickAttrs(model, payload) {
  const attrs = model?.rawAttributes || {};
  const out = {};
  for (const k of Object.keys(payload)) {
    if (attrs[k]) out[k] = payload[k];
  }
  return out;
}

function hasCol(model, col) {
  return !!(model?.rawAttributes || {})[col];
}

/* ============================================================
 * Receipt items availability validation
 * - Per receipt + book + is_specimen total allocation <= received qty
 * ============================================================ */
async function validateAgainstReceiptItems({ receiptId, newAllocations, mode, t }) {
  const items = await SupplierReceiptItem.findAll({
    where: { supplier_receipt_id: receiptId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

  const availMap = new Map(); // key => received qty
  for (const it of items) {
    const bookId = num(it.book_id);
    const isSpec = asBool(it.is_specimen);
    const received = Math.max(0, Math.floor(num(it.received_qty ?? it.qty ?? 0)));
    availMap.set(`${bookId}|${isSpec ? 1 : 0}`, received);
  }

  // Existing allocations (if APPEND we must add them; if REPLACE we ignore them)
  let existing = [];
  if (mode === "APPEND") {
    existing = await SupplierReceiptAllocation.findAll({
      where: { supplier_receipt_id: receiptId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
  }

  const sumMap = new Map(); // key => total alloc
  const add = (book_id, is_specimen, qty) => {
    const key = `${num(book_id)}|${asBool(is_specimen) ? 1 : 0}`;
    sumMap.set(key, (sumMap.get(key) || 0) + Math.max(0, Math.floor(num(qty))));
  };

  for (const ex of existing) add(ex.book_id, ex.is_specimen, ex.qty);
  for (const a of newAllocations) add(a.book_id, a.is_specimen, a.qty);

  for (const [key, total] of sumMap.entries()) {
    const allowed = availMap.get(key) || 0;
    if (total > allowed) {
      return `Allocation exceeds receipt received qty for key=${key}. Total=${total}, Allowed=${allowed}`;
    }
  }

  return null;
}

/* ============================================================
 * FIFO Issue from receipt-specific batches
 * Batches created in your posting:
 *   ref_table='supplier_receipts' and ref_id=receipt.id
 * ============================================================ */
async function issueFromReceiptBatchesFIFO({ receipt, allocRow, t }) {
  if (!InventoryBatch || !InventoryTxn) return;

  const receiptId = num(receipt.id);
  const bookId = num(allocRow.book_id);
  let need = Math.max(0, Math.floor(num(allocRow.qty)));
  if (!bookId || need <= 0) return;

  const batches = await InventoryBatch.findAll({
    where: pickAttrs(InventoryBatch, {
      ref_table: "supplier_receipts",
      ref_id: receiptId,
      book_id: bookId,
    }),
    transaction: t,
    lock: t.LOCK.UPDATE,
    order: [["id", "ASC"]],
  });

  if (!batches.length) {
    throw new Error(`No inventory batches found for receipt=${receiptId}, book_id=${bookId}.`);
  }

  const totalAvail = batches.reduce((s, b) => s + Math.max(0, num(b.available_qty)), 0);
  if (totalAvail < need) {
    throw new Error(`Not enough stock in receipt batches. book_id=${bookId}, need=${need}, available=${totalAvail}.`);
  }

  for (const b of batches) {
    if (need <= 0) break;

    const avail = Math.max(0, num(b.available_qty));
    if (avail <= 0) continue;

    const take = Math.min(avail, need);

    const txnPayload = pickAttrs(InventoryTxn, {
      book_id: bookId,

      batch_id: b.id,
      inventory_batch_id: b.id,

      qty: take,
      txn_type: "OUT",
      type: "OUT",

      ref_type: "SCHOOL_ALLOCATION",
      ref_table: "supplier_receipt_allocations",
      ref_id: allocRow.id,
      ref_no: receipt.receipt_no,

      // optional if column exists
      school_id: allocRow.school_id,

      notes: `Issue to school_id=${allocRow.school_id} via receipt ${receipt.receipt_no}`,
    });

    await InventoryTxn.create(txnPayload, { transaction: t });

    b.available_qty = num(b.available_qty) - take;
    await b.save({ transaction: t });

    need -= take;
  }
}

/* ============================================================
 * Reverse inventory for allocations (REPLACE mode)
 * - We add stock back to the same batches using txns by ref_id
 * ============================================================ */
async function reverseInventoryForAllocationIds({ receipt, allocationIds, t }) {
  if (!InventoryBatch || !InventoryTxn) return;
  if (!allocationIds.length) return;

  // must have ref_id to safely reverse
  if (!hasCol(InventoryTxn, "ref_id")) {
    throw new Error("InventoryTxn.ref_id column missing; cannot reverse allocations safely.");
  }

  const outTxns = await InventoryTxn.findAll({
    where: {
      ...pickAttrs(InventoryTxn, {
        ref_table: "supplier_receipt_allocations",
        txn_type: "OUT",
      }),
      ref_id: { [Op.in]: allocationIds },
    },
    transaction: t,
    lock: t.LOCK.UPDATE,
    order: [["id", "ASC"]],
  });

  for (const tx of outTxns) {
    const batchId = num(tx.batch_id || tx.inventory_batch_id);
    const qty = Math.max(0, Math.floor(num(tx.qty)));
    if (!batchId || qty <= 0) continue;

    const batch = await InventoryBatch.findByPk(batchId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!batch) continue;

    batch.available_qty = num(batch.available_qty) + qty;
    await batch.save({ transaction: t });

    // audit reversal IN txn (optional but good)
    const revPayload = pickAttrs(InventoryTxn, {
      book_id: num(tx.book_id),

      batch_id: batch.id,
      inventory_batch_id: batch.id,

      qty,
      txn_type: "IN",
      type: "IN",

      ref_type: "SCHOOL_ALLOCATION_REVERSAL",
      ref_table: "supplier_receipt_allocations",
      ref_id: num(tx.ref_id),
      ref_no: receipt.receipt_no,

      school_id: tx.school_id,
      notes: `Reverse allocation ${tx.ref_id} for receipt ${receipt.receipt_no}`,
    });

    await InventoryTxn.create(revPayload, { transaction: t });
  }
}

/* ============================================================
 * Controllers
 * ============================================================ */

/**
 * GET /api/supplier-receipts/:id/allocations
 */
exports.listByReceipt = async (request, reply) => {
  try {
    const receiptId = num(request.params?.id);

    const rows = await SupplierReceiptAllocation.findAll({
      where: { supplier_receipt_id: receiptId },
      include: [
        School ? { model: School, as: "school", attributes: ["id", "name", "city"] } : null,
        Book ? { model: Book, as: "book", attributes: ["id", "title"] } : null,
      ].filter(Boolean),
      order: [["id", "ASC"]],
    });

    return reply.send({ allocations: rows });
  } catch (err) {
    request.log?.error?.(err);
    console.error("❌ listSupplierReceiptAllocations error:", err);
    return reply.code(500).send({ error: "Failed to load allocations" });
  }
};

/**
 * POST /api/supplier-receipts/:id/allocations
 * body: {
 *   mode: "APPEND" | "REPLACE",
 *   allocations: [{ school_id, book_id, qty, is_specimen, specimen_reason, remarks, issued_date }]
 * }
 *
 * ✅ Requires receipt.status = received
 * ✅ Requires receipt.posted_at (if column exists)
 * ✅ Creates allocations
 * ✅ Deducts inventory (FIFO) from receipt batches
 */
exports.saveForReceipt = async (request, reply) => {
  const receiptId = num(request.params?.id);
  const body = request.body || {};
  const mode = String(body.mode || "APPEND").trim().toUpperCase();

  if (!receiptId) return reply.code(400).send({ error: "Invalid receipt id" });

  const incoming = Array.isArray(body.allocations) ? body.allocations : [];
  const clean = incoming
    .map((a) => ({
      supplier_receipt_id: receiptId,
      school_id: num(a.school_id),
      book_id: num(a.book_id),
      qty: Math.max(0, Math.floor(num(a.qty))),
      is_specimen: asBool(a.is_specimen),
      specimen_reason: a.specimen_reason ? String(a.specimen_reason).trim() : null,
      remarks: a.remarks ? String(a.remarks).trim() : null,
      issued_date: a.issued_date ? new Date(a.issued_date) : null,
    }))
    .filter((a) => a.school_id && a.book_id && a.qty > 0);

  if (!clean.length) return reply.code(400).send({ error: "No allocations provided" });

  const t = await sequelize.transaction();
  try {
    const receipt = await SupplierReceipt.findByPk(receiptId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!receipt) {
      await t.rollback();
      return reply.code(404).send({ error: "Receipt not found" });
    }

    const st = String(receipt.status || "").toLowerCase();
    if (st !== "received") {
      await t.rollback();
      return reply.code(400).send({ error: "Allocate allowed only when receipt status is RECEIVED." });
    }

    // if posted_at exists, require posted (inventory batches created)
    if (hasCol(SupplierReceipt, "posted_at") && !receipt.posted_at) {
      await t.rollback();
      return reply.code(400).send({ error: "Receipt not posted yet. Please mark received properly first." });
    }

    // validate school ids (optional, but safer)
    if (School) {
      const schoolIds = [...new Set(clean.map((x) => x.school_id))];
      const count = await School.count({ where: { id: { [Op.in]: schoolIds } }, transaction: t });
      if (count !== schoolIds.length) {
        await t.rollback();
        return reply.code(400).send({ error: "One or more school_id is invalid." });
      }
    }

    // ✅ validate against receipt items received_qty
    const errMsg = await validateAgainstReceiptItems({ receiptId, newAllocations: clean, mode, t });
    if (errMsg) {
      await t.rollback();
      return reply.code(400).send({ error: errMsg });
    }

    // REPLACE mode: reverse previous allocations inventory and delete old rows
    if (mode === "REPLACE") {
      const prev = await SupplierReceiptAllocation.findAll({
        where: { supplier_receipt_id: receiptId },
        transaction: t,
        lock: t.LOCK.UPDATE,
        order: [["id", "ASC"]],
      });

      const prevIds = prev.map((x) => num(x.id)).filter(Boolean);

      if (prevIds.length) {
        await reverseInventoryForAllocationIds({ receipt, allocationIds: prevIds, t });
      }

      await SupplierReceiptAllocation.destroy({
        where: { supplier_receipt_id: receiptId },
        transaction: t,
      });
    }

    // create allocations
    const created = await SupplierReceiptAllocation.bulkCreate(
      clean.map((x) => ({
        ...x,
        issued_date: x.issued_date || receipt.received_date || new Date(),
      })),
      { transaction: t }
    );

    // inventory OUT for each created allocation
    for (const a of created) {
      await issueFromReceiptBatchesFIFO({ receipt, allocRow: a, t });
    }

    await t.commit();
    return reply.send({ ok: true, mode, allocations: created });
  } catch (err) {
    try {
      await t.rollback();
    } catch (_) {}
    request.log?.error?.(err);
    console.error("❌ saveSupplierReceiptAllocations error:", err);
    return reply.code(500).send({
      error: "Failed to save allocations",
      details: err?.message || String(err),
    });
  }
};

/**
 * GET /api/supplier-receipt-allocations
 * school-wise report
 * query: school_id, from, to, supplier_id, book_id, q
 */
exports.listSchoolWise = async (request, reply) => {
  try {
    const { school_id, from, to, supplier_id, book_id, q } = request.query || {};

    const where = {};
    if (school_id) where.school_id = num(school_id);
    if (book_id) where.book_id = num(book_id);

    if (from || to) {
      where.issued_date = {};
      if (from) where.issued_date[Op.gte] = String(from);
      if (to) where.issued_date[Op.lte] = String(to);
    }

    const include = [
      { model: SupplierReceipt, as: "receipt", attributes: ["id", "receipt_no", "supplier_id", "received_date"] },
      School ? { model: School, as: "school", attributes: ["id", "name", "city"] } : null,
      Book ? { model: Book, as: "book", attributes: ["id", "title"] } : null,
    ].filter(Boolean);

    // filter by supplier_id via receipt join
    if (supplier_id) {
      include[0].where = { supplier_id: num(supplier_id) };
      include[0].required = true;
    }

    // search by receipt_no (q)
    if (q && String(q).trim()) {
      include[0].where = { ...(include[0].where || {}), receipt_no: { [Op.like]: `%${String(q).trim()}%` } };
      include[0].required = true;
    }

    const rows = await SupplierReceiptAllocation.findAll({
      where,
      include,
      order: [["id", "DESC"]],
      limit: 500,
    });

    return reply.send({ allocations: rows });
  } catch (err) {
    request.log?.error?.(err);
    console.error("❌ listSchoolWiseAllocations error:", err);
    return reply.code(500).send({ error: "Failed to list allocations" });
  }
};
