// src/controllers/supplierPaymentController.js
"use strict";

const { Op } = require("sequelize");
const {
  sequelize,
  Supplier,
  SupplierPayment,
  SupplierLedgerTxn,
} = require("../models");

/* ---------------- Helpers ---------------- */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n) => Math.round(num(n) * 100) / 100;

const safeDate = (v) => {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
};

const cleanStr = (v, max = 255) => {
  const s = String(v || "").trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
};

const buildPaymentRefNo = (payment) => {
  // prefer user-provided ref_no, else fallback
  return (
    cleanStr(payment?.ref_no, 80) ||
    cleanStr(payment?.txn_ref, 80) ||
    `PAY-${payment?.id || ""}`
  );
};

/**
 * Notes:
 * - Debit = payable increases (purchase receive)
 * - Credit = payable decreases (payment made to supplier)
 */

/* ============================
   POST /api/suppliers/:supplierId/payments
   Body:
   {
     amount: number,
     pay_date?: date,
     payment_mode?: string,
     ref_no?: string,
     narration?: string,
     notes?: string,
     txn_ref?: string (optional)
   }
   ============================ */
exports.createPayment = async (request, reply) => {
  const t = await sequelize.transaction();
  try {
    const supplierId = num(request.params?.supplierId);
    if (!supplierId) {
      await t.rollback();
      return reply.code(400).send({ error: "Invalid supplierId" });
    }

    const supplier = await Supplier.findByPk(supplierId, { transaction: t });
    if (!supplier) {
      await t.rollback();
      return reply.code(404).send({ error: "Supplier not found" });
    }

    const body = request.body || {};
    const amount = round2(body.amount);

    if (!amount || amount <= 0) {
      await t.rollback();
      return reply.code(400).send({ error: "Amount must be > 0" });
    }

    const payDate = safeDate(body.pay_date) || new Date();

    // These fields depend on your SupplierPayment model. We set them only if present.
    const paymentPayload = {
      supplier_id: supplierId,

      // common date column names: pay_date / txn_date / payment_date
      ...(SupplierPayment.rawAttributes.pay_date
        ? { pay_date: payDate }
        : SupplierPayment.rawAttributes.txn_date
        ? { txn_date: payDate }
        : SupplierPayment.rawAttributes.payment_date
        ? { payment_date: payDate }
        : {}),

      // amount column name possibilities
      ...(SupplierPayment.rawAttributes.amount
        ? { amount }
        : SupplierPayment.rawAttributes.paid_amount
        ? { paid_amount: amount }
        : SupplierPayment.rawAttributes.payment_amount
        ? { payment_amount: amount }
        : { amount }), // fallback

      ...(SupplierPayment.rawAttributes.payment_mode
        ? { payment_mode: cleanStr(body.payment_mode, 30) }
        : SupplierPayment.rawAttributes.mode
        ? { mode: cleanStr(body.payment_mode || body.mode, 30) }
        : {}),

      ...(SupplierPayment.rawAttributes.ref_no
        ? { ref_no: cleanStr(body.ref_no, 80) }
        : {}),

      ...(SupplierPayment.rawAttributes.txn_ref
        ? { txn_ref: cleanStr(body.txn_ref, 80) }
        : {}),

      ...(SupplierPayment.rawAttributes.narration
        ? { narration: cleanStr(body.narration, 255) }
        : {}),

      ...(SupplierPayment.rawAttributes.notes
        ? { notes: cleanStr(body.notes, 255) }
        : {}),
    };

    const payment = await SupplierPayment.create(paymentPayload, {
      transaction: t,
    });

    const refNo = buildPaymentRefNo(payment);

    // ✅ Post to ledger as CREDIT (payable decreases)
    // Unique index on ledger: (supplier_id, txn_type, ref_table, ref_id)
    // => prevents double-posting if createPayment is retried accidentally.
    const ledgerPayload = {
      supplier_id: supplierId,
      txn_date: payDate,
      txn_type: "PAYMENT",
      ref_table: "supplier_payments",
      ref_id: payment.id,
      ref_no: refNo,
      debit: 0,
      credit: amount,
      narration: cleanStr(
        body.narration || `Payment to supplier (${refNo})`,
        255
      ),
    };

    // If the row already exists due to retry, we keep it idempotent.
    await SupplierLedgerTxn.findOrCreate({
      where: {
        supplier_id: supplierId,
        txn_type: "PAYMENT",
        ref_table: "supplier_payments",
        ref_id: payment.id,
      },
      defaults: ledgerPayload,
      transaction: t,
    });

    await t.commit();

    return reply.send({
      message: "Payment saved and ledger credited.",
      supplier,
      payment,
    });
  } catch (err) {
    await t.rollback();
    request.log?.error?.(err);
    console.error("❌ supplier payment create error:", err);
    return reply.code(500).send({ error: "Failed to create payment" });
  }
};

/* ============================
   GET /api/suppliers/:supplierId/payments
   Query: from?, to?, limit?
   ============================ */
exports.listPayments = async (request, reply) => {
  try {
    const supplierId = num(request.params?.supplierId);
    if (!supplierId)
      return reply.code(400).send({ error: "Invalid supplierId" });

    const supplier = await Supplier.findByPk(supplierId);
    if (!supplier) return reply.code(404).send({ error: "Supplier not found" });

    const { from, to, limit } = request.query || {};

    const where = { supplier_id: supplierId };

    const fromD = safeDate(from);
    const toD = safeDate(to);

    // detect which date column exists on SupplierPayment
    const dateCol =
      (SupplierPayment.rawAttributes.pay_date && "pay_date") ||
      (SupplierPayment.rawAttributes.txn_date && "txn_date") ||
      (SupplierPayment.rawAttributes.payment_date && "payment_date") ||
      null;

    if (dateCol && (fromD || toD)) {
      where[dateCol] = {};
      if (fromD) where[dateCol][Op.gte] = fromD;
      if (toD) where[dateCol][Op.lte] = toD;
    }

    const rows = await SupplierPayment.findAll({
      where,
      order: [
        [dateCol || "createdAt", "DESC"],
        ["id", "DESC"],
      ],
      limit: Math.min(500, Math.max(1, num(limit) || 200)),
    });

    return reply.send({ supplier, payments: rows });
  } catch (err) {
    request.log?.error?.(err);
    console.error("❌ supplier payments list error:", err);
    return reply.code(500).send({ error: "Failed to fetch payments" });
  }
};

/* ============================
   GET /api/suppliers/:supplierId/payments/:paymentId
   - Fetch single payment (for View modal)
   ============================ */
exports.getPaymentById = async (request, reply) => {
  try {
    const supplierId = num(request.params?.supplierId);
    const paymentId = num(request.params?.paymentId);

    if (!supplierId)
      return reply.code(400).send({ error: "Invalid supplierId" });
    if (!paymentId)
      return reply.code(400).send({ error: "Invalid paymentId" });

    const supplier = await Supplier.findByPk(supplierId);
    if (!supplier) return reply.code(404).send({ error: "Supplier not found" });

    const payment = await SupplierPayment.findOne({
      where: { id: paymentId, supplier_id: supplierId },
    });

    if (!payment) return reply.code(404).send({ error: "Payment not found" });

    // Keep response shape flexible for frontend:
    // frontend accepts { payment } or direct object
    return reply.send({ supplier, payment });
  } catch (err) {
    request.log?.error?.(err);
    console.error("❌ supplier payment get error:", err);
    return reply.code(500).send({ error: "Failed to fetch payment" });
  }
};

/* ============================
   DELETE /api/suppliers/:supplierId/payments/:paymentId   ✅ (preferred)
   ALSO supports: /api/suppliers/payments/:paymentId       ✅ (backward compatible)
   - Deletes payment
   - Deletes corresponding ledger txn (PAYMENT credit)
   ============================ */
exports.deletePayment = async (request, reply) => {
  const t = await sequelize.transaction();
  try {
    // ✅ support both route shapes:
    // 1) /:supplierId/payments/:paymentId  (frontend wants this)
    // 2) /payments/:paymentId              (your existing route)
    const paymentId = num(request.params?.paymentId);
    const supplierIdFromParams = num(request.params?.supplierId); // may be 0 in old route

    if (!paymentId) {
      await t.rollback();
      return reply.code(400).send({ error: "Invalid paymentId" });
    }

    // ensure payment exists
    const payment = await SupplierPayment.findByPk(paymentId, { transaction: t });
    if (!payment) {
      await t.rollback();
      return reply.code(404).send({ error: "Payment not found" });
    }

    const supplierId = num(payment.supplier_id);

    // extra guard if supplierId was provided in route
    if (supplierIdFromParams && supplierIdFromParams !== supplierId) {
      await t.rollback();
      return reply
        .code(400)
        .send({ error: "Payment does not belong to this supplier" });
    }

    // delete ledger row first (safe)
    await SupplierLedgerTxn.destroy({
      where: {
        supplier_id: supplierId,
        txn_type: "PAYMENT",
        ref_table: "supplier_payments",
        ref_id: paymentId,
      },
      transaction: t,
    });

    await payment.destroy({ transaction: t });

    await t.commit();
    return reply.send({ message: "Payment deleted and ledger updated." });
  } catch (err) {
    await t.rollback();
    request.log?.error?.(err);
    console.error("❌ supplier payment delete error:", err);
    return reply.code(500).send({ error: "Failed to delete payment" });
  }
};
