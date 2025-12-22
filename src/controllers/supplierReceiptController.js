"use strict";

const { Op } = require("sequelize");
const {
  sequelize,
  Supplier,
  Book,
  InventoryBatch,
  InventoryTxn,
  SupplierReceipt,
  SupplierReceiptItem,
  SupplierLedgerTxn,
} = require("../models");

/* ---------------- Helpers ---------------- */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n) => Math.round(num(n) * 100) / 100;

function now() {
  return new Date();
}

/**
 * Generate receipt number like: SR-2025-12-000001
 */
async function makeReceiptNo(t) {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");

  const last = await SupplierReceipt.findOne({
    order: [["id", "DESC"]],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

  const lastSeq = last && last.receipt_no ? String(last.receipt_no).split("-").pop() : "0";
  const seq = String(num(lastSeq) + 1).padStart(6, "0");
  return `SR-${yyyy}-${mm}-${seq}`;
}

function calcItemLine({ qty, rate, discType, discVal }) {
  const q = Math.max(0, Math.floor(num(qty)));
  const r = Math.max(0, num(rate));

  const gross = round2(q * r);

  let discount = 0;
  const t = String(discType || "NONE").toUpperCase();
  const v = num(discVal);

  if (t === "PERCENT") {
    discount = round2(gross * (Math.max(0, v) / 100));
  } else if (t === "AMOUNT") {
    discount = round2(Math.max(0, v));
  }

  if (discount > gross) discount = gross;

  const net = round2(gross - discount);

  return {
    qty: q,
    rate: round2(r),
    gross_amount: gross,
    discount_amount: discount,
    net_amount: net,
  };
}

function calcHeaderTotals({
  itemsNetSum,
  billDiscountType,
  billDiscountValue,
  shipping_charge,
  other_charge,
  round_off,
}) {
  const sub_total = round2(itemsNetSum);

  const t = String(billDiscountType || "NONE").toUpperCase();
  const v = num(billDiscountValue);

  let bill_discount_amount = 0;
  if (t === "PERCENT") {
    bill_discount_amount = round2(sub_total * (Math.max(0, v) / 100));
  } else if (t === "AMOUNT") {
    bill_discount_amount = round2(Math.max(0, v));
  }

  if (bill_discount_amount > sub_total) bill_discount_amount = sub_total;

  const ship = round2(Math.max(0, num(shipping_charge)));
  const other = round2(Math.max(0, num(other_charge)));
  const ro = round2(num(round_off)); // can be negative/positive

  const grand_total = round2(sub_total - bill_discount_amount + ship + other + ro);

  return { sub_total, bill_discount_amount, grand_total };
}

function pickAttrs(model, payload) {
  const attrs = model?.rawAttributes || {};
  const out = {};
  for (const k of Object.keys(payload)) {
    if (attrs[k]) out[k] = payload[k];
  }
  return out;
}

/* ---------------- Controller ---------------- */

/**
 * POST /api/supplier-receipts
 * body: { supplier_id, school_order_id?, invoice_no?, academic_session?, invoice_date?, received_date?,
 *         status?, remarks?, bill_discount_type?, bill_discount_value?, shipping_charge?, other_charge?, round_off?,
 *         items: [{ book_id, qty, rate, item_discount_type?, item_discount_value? }, ...]
 *       }
 */
exports.create = async (request, reply) => {
  const body = request.body || {};

  const supplier_id = num(body.supplier_id);
  const school_order_id = body.school_order_id ? num(body.school_order_id) : null;

  const invoice_no = body.invoice_no ? String(body.invoice_no).trim() : null;
  const academic_session = body.academic_session ? String(body.academic_session).trim() : null;

  const invoice_date = body.invoice_date ? new Date(body.invoice_date) : now();
  const received_date = body.received_date ? new Date(body.received_date) : now();

  const remarks = body.remarks ? String(body.remarks) : null;

  const bill_discount_type = body.bill_discount_type || "NONE";
  const bill_discount_value = body.bill_discount_value ?? null;

  const shipping_charge = body.shipping_charge ?? 0;
  const other_charge = body.other_charge ?? 0;
  const round_off = body.round_off ?? 0;

  const status = body.status ? String(body.status) : "received";

  const items = Array.isArray(body.items) ? body.items : [];

  if (!supplier_id) return reply.code(400).send({ error: "supplier_id is required" });
  if (!items.length) return reply.code(400).send({ error: "At least one item is required" });

  for (const [i, it] of items.entries()) {
    if (!it || !num(it.book_id)) {
      return reply.code(400).send({ error: `items[${i}].book_id is required` });
    }
    if (num(it.qty) <= 0) {
      return reply.code(400).send({ error: `items[${i}].qty must be > 0` });
    }
  }

  const t = await sequelize.transaction();
  try {
    const supplier = await Supplier.findByPk(supplier_id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!supplier) {
      await t.rollback();
      return reply.code(404).send({ error: "Supplier not found" });
    }

    const calcLines = items.map((it) => {
      const discType = it.item_discount_type || "NONE";
      const discVal = it.item_discount_value ?? null;

      const line = calcItemLine({
        qty: it.qty,
        rate: it.rate,
        discType,
        discVal,
      });

      return {
        book_id: num(it.book_id),
        qty: line.qty,
        rate: line.rate,
        item_discount_type: String(discType).toUpperCase(),
        item_discount_value: discVal === null || discVal === undefined ? null : round2(discVal),
        gross_amount: line.gross_amount,
        discount_amount: line.discount_amount,
        net_amount: line.net_amount,
      };
    });

    const itemsNetSum = calcLines.reduce((s, r) => s + num(r.net_amount), 0);

    const totals = calcHeaderTotals({
      itemsNetSum,
      billDiscountType: bill_discount_type,
      billDiscountValue: bill_discount_value,
      shipping_charge,
      other_charge,
      round_off,
    });

    if (totals.grand_total < 0) {
      await t.rollback();
      return reply.code(400).send({ error: "grand_total cannot be negative" });
    }

    const receipt_no = await makeReceiptNo(t);

    const receipt = await SupplierReceipt.create(
      {
        supplier_id,
        school_order_id,
        receipt_no,
        invoice_no,
        academic_session,
        invoice_date,
        received_date,
        status: status === "draft" ? "draft" : "received",
        remarks,

        sub_total: totals.sub_total,

        bill_discount_type: String(bill_discount_type).toUpperCase(),
        bill_discount_value:
          bill_discount_value === null || bill_discount_value === undefined
            ? null
            : round2(bill_discount_value),
        bill_discount_amount: totals.bill_discount_amount,

        shipping_charge: round2(Math.max(0, num(shipping_charge))),
        other_charge: round2(Math.max(0, num(other_charge))),
        round_off: round2(num(round_off)),

        grand_total: totals.grand_total,
      },
      { transaction: t }
    );

    await SupplierReceiptItem.bulkCreate(
      calcLines.map((r) => ({ ...r, supplier_receipt_id: receipt.id })),
      { transaction: t }
    );

    // Update Book rate & discount_percent (only if item discount is percent)
    for (const r of calcLines) {
      const discType = String(r.item_discount_type || "NONE").toUpperCase();
      const discVal = num(r.item_discount_value);

      const updatePayload = { rate: round2(r.rate) };
      if (discType === "PERCENT") updatePayload.discount_percent = round2(Math.max(0, discVal));

      await Book.update(updatePayload, { where: { id: r.book_id }, transaction: t });
    }

    // Inventory IN (Supplier Receipt)
    for (const r of calcLines) {
      const batchPayload = pickAttrs(InventoryBatch, {
        book_id: r.book_id,

        // ✅ supplier-focused
        supplier_id: supplier_id,

        // remove publisher_id usage (only included if column exists)
        publisher_id: null,

        source_type: "SUPPLIER_RECEIPT",
        ref_table: "supplier_receipts",
        ref_id: receipt.id,

        received_qty: r.qty,
        available_qty: r.qty,

        rate: r.rate,
        unit_cost: r.rate,
        cost_price: r.rate,

        remarks: `Receipt ${receipt.receipt_no}`,
      });

      const batch = await InventoryBatch.create(batchPayload, { transaction: t });

      const txnPayload = pickAttrs(InventoryTxn, {
        book_id: r.book_id,
        batch_id: batch.id,
        qty: r.qty,
        txn_type: "IN",
        type: "IN",
        ref_table: "supplier_receipts",
        ref_id: receipt.id,
        notes: `Receive via ${receipt.receipt_no}`,
      });

      await InventoryTxn.create(txnPayload, { transaction: t });
    }

    // Ledger posting (only if received)
    if (receipt.status === "received") {
      // ✅ idempotent: delete existing purchase posting for this receipt if any
      await SupplierLedgerTxn.destroy({
        where: {
          supplier_id,
          txn_type: "PURCHASE_RECEIVE",
          ref_table: "supplier_receipts",
          ref_id: receipt.id,
        },
        transaction: t,
      });

      await SupplierLedgerTxn.create(
        {
          supplier_id,
          txn_date: receipt.received_date || receipt.invoice_date || now(),
          txn_type: "PURCHASE_RECEIVE",
          ref_table: "supplier_receipts",
          ref_id: receipt.id,
          ref_no: receipt.receipt_no,
          debit: receipt.grand_total,
          credit: 0,
          narration: invoice_no ? `Purchase Invoice ${invoice_no}` : `Receipt ${receipt.receipt_no}`,
        },
        { transaction: t }
      );
    }

    await t.commit();

    const full = await SupplierReceipt.findByPk(receipt.id, {
      include: [
        { model: Supplier, as: "supplier" },
        { model: SupplierReceiptItem, as: "items", include: [{ model: Book, as: "book" }] },
      ],
    });

    return reply.code(201).send({ receipt: full });
  } catch (err) {
    try {
      await t.rollback();
    } catch (_) {}
    request.log?.error?.(err);
    console.error("❌ createSupplierReceipt error:", err);
    return reply.code(500).send({
      error: "Failed to create supplier receipt",
      details: err?.message || String(err),
    });
  }
};

/**
 * GET /api/supplier-receipts
 * Query: supplier_id?, status?, from?, to?
 */
exports.list = async (request, reply) => {
  try {
    const { supplier_id, status, from, to } = request.query || {};

    const where = {};
    if (supplier_id) where.supplier_id = num(supplier_id);
    if (status) where.status = String(status);

    if (from || to) {
      where.invoice_date = {};
      if (from) where.invoice_date[Op.gte] = new Date(String(from));
      if (to) where.invoice_date[Op.lte] = new Date(String(to));
    }

    const rows = await SupplierReceipt.findAll({
      where,
      order: [["id", "DESC"]],
      include: [{ model: Supplier, as: "supplier" }],
      limit: 200,
    });

    return reply.send({ receipts: rows });
  } catch (err) {
    request.log?.error?.(err);
    console.error("❌ listSupplierReceipts error:", err);
    return reply.code(500).send({ error: "Failed to list receipts" });
  }
};

/**
 * GET /api/supplier-receipts/:id
 */
exports.getById = async (request, reply) => {
  try {
    const id = num(request.params?.id);

    const row = await SupplierReceipt.findByPk(id, {
      include: [
        { model: Supplier, as: "supplier" },
        { model: SupplierReceiptItem, as: "items", include: [{ model: Book, as: "book" }] },
      ],
    });

    if (!row) return reply.code(404).send({ error: "Receipt not found" });
    return reply.send({ receipt: row });
  } catch (err) {
    request.log?.error?.(err);
    console.error("❌ getSupplierReceiptById error:", err);
    return reply.code(500).send({ error: "Failed to fetch receipt" });
  }
};

/**
 * PATCH /api/supplier-receipts/:id/status
 * body: { status: "draft" | "received" | "cancelled" }
 */
exports.updateStatus = async (request, reply) => {
  const id = num(request.params?.id);
  const nextStatus = String(request.body?.status || "").toLowerCase();

  if (!["draft", "received", "cancelled"].includes(nextStatus)) {
    return reply.code(400).send({ error: "Invalid status" });
  }

  const t = await sequelize.transaction();
  try {
    const receipt = await SupplierReceipt.findByPk(id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!receipt) {
      await t.rollback();
      return reply.code(404).send({ error: "Receipt not found" });
    }

    const prevStatus = receipt.status;
    receipt.status = nextStatus;
    await receipt.save({ transaction: t });

    // When moving to received -> ensure ledger posted
    if (prevStatus !== "received" && nextStatus === "received") {
      // idempotent delete + create
      await SupplierLedgerTxn.destroy({
        where: {
          supplier_id: receipt.supplier_id,
          ref_table: "supplier_receipts",
          ref_id: receipt.id,
          txn_type: "PURCHASE_RECEIVE",
        },
        transaction: t,
      });

      await SupplierLedgerTxn.create(
        {
          supplier_id: receipt.supplier_id,
          txn_date: receipt.received_date || receipt.invoice_date || now(),
          txn_type: "PURCHASE_RECEIVE",
          ref_table: "supplier_receipts",
          ref_id: receipt.id,
          ref_no: receipt.receipt_no,
          debit: receipt.grand_total,
          credit: 0,
          narration: receipt.invoice_no
            ? `Purchase Invoice ${receipt.invoice_no}`
            : `Receipt ${receipt.receipt_no}`,
        },
        { transaction: t }
      );
    }

    // If cancelled -> remove ledger posting (optional but recommended)
    if (nextStatus === "cancelled") {
      await SupplierLedgerTxn.destroy({
        where: {
          supplier_id: receipt.supplier_id,
          ref_table: "supplier_receipts",
          ref_id: receipt.id,
          txn_type: "PURCHASE_RECEIVE",
        },
        transaction: t,
      });
    }

    await t.commit();
    return reply.send({ ok: true });
  } catch (err) {
    try {
      await t.rollback();
    } catch (_) {}
    request.log?.error?.(err);
    console.error("❌ updateSupplierReceiptStatus error:", err);
    return reply.code(500).send({ error: "Failed to update status" });
  }
};
