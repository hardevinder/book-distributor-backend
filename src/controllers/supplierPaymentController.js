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
  return (
    cleanStr(payment?.ref_no, 80) ||
    cleanStr(payment?.txn_ref, 80) ||
    `PAY-${payment?.id || ""}`
  );
};

/**
 * Notes:
 * - Debit = payable increases (purchase receive)
 * - Credit = payable decreases (payment made OR discount received)
 *
 * Payment discount logic:
 * - Cash paid (amount)
 * - Discount received (discount)
 * - Ledger credit = amount + discount
 */

/* ============================
   POST /api/suppliers/:supplierId/payments
   Body:
   {
     amount: number,                 // cash paid
     discount_amount?: number,       // optional discount received
     discount_percent?: number,      // optional (only one of discount_* allowed)
     payment_date?: date,            // (DATEONLY in your model)
     mode?: "CASH"|"UPI"|"BANK"|"CHEQUE"|"OTHER",
     ref_no?: string,
     narration?: string,
     created_by?: string
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

    const amount = round2(body.amount); // cash paid
    if (!amount || amount <= 0) {
      await t.rollback();
      return reply.code(400).send({ error: "Amount must be > 0" });
    }

    // ✅ discount: allow either percent OR fixed (not both)
    const discountPercentRaw = body.discount_percent;
    const discountAmountRaw = body.discount_amount;

    const hasPct =
      discountPercentRaw !== undefined &&
      discountPercentRaw !== null &&
      String(discountPercentRaw).trim() !== "";

    const hasFix =
      discountAmountRaw !== undefined &&
      discountAmountRaw !== null &&
      String(discountAmountRaw).trim() !== "";

    if (hasPct && hasFix) {
      await t.rollback();
      return reply.code(400).send({
        error: "Enter either discount_percent OR discount_amount (not both).",
      });
    }

    let discount_percent = hasPct ? round2(discountPercentRaw) : 0;
    let discount_amount = hasFix ? round2(discountAmountRaw) : 0;

    if (discount_percent < 0 || discount_amount < 0) {
      await t.rollback();
      return reply.code(400).send({ error: "Discount cannot be negative." });
    }

    if (hasPct) {
      if (discount_percent > 100) {
        await t.rollback();
        return reply
          .code(400)
          .send({ error: "discount_percent cannot exceed 100." });
      }
      discount_amount = round2((amount * discount_percent) / 100);
    } else if (hasFix) {
      discount_percent = amount > 0 ? round2((discount_amount * 100) / amount) : 0;
    }

    if (discount_amount > amount) {
      await t.rollback();
      return reply.code(400).send({
        error: "discount_amount cannot be greater than amount (cash paid).",
      });
    }

    const total_settled = round2(amount + discount_amount);

    // ✅ payment_date is DATEONLY in your model
    // Accept body.payment_date, else today (DATEONLY)
    const paymentDateObj = safeDate(body.payment_date) || new Date();
    const payment_date = paymentDateObj.toISOString().slice(0, 10); // YYYY-MM-DD

    const mode = cleanStr(body.mode || body.payment_mode, 10) || "CASH";

    // ✅ Build payment payload matching your model
    const paymentPayload = {
      supplier_id: supplierId,
      payment_date,
      amount,
      mode,
      ref_no: cleanStr(body.ref_no, 80),
      narration: cleanStr(body.narration, 255),
      created_by: cleanStr(body.created_by, 80),
    };

    // ✅ save discount fields only if columns exist (so code won’t crash before migration)
    if (SupplierPayment.rawAttributes.discount_amount) {
      paymentPayload.discount_amount = discount_amount;
    }
    if (SupplierPayment.rawAttributes.discount_percent) {
      paymentPayload.discount_percent = discount_percent;
    }
    if (SupplierPayment.rawAttributes.total_settled) {
      paymentPayload.total_settled = total_settled;
    }

    const payment = await SupplierPayment.create(paymentPayload, {
      transaction: t,
    });

    const refNo = buildPaymentRefNo(payment);

    // ✅ ledger date should be a full DateTime
    const ledgerDate = paymentDateObj;

    const narrationBase =
      body.narration ||
      (discount_amount > 0
        ? `Payment (₹${amount}) + Discount (₹${discount_amount}) (${refNo})`
        : `Payment to supplier (${refNo})`);

    const ledgerPayload = {
      supplier_id: supplierId,
      txn_date: ledgerDate,
      txn_type: "PAYMENT",
      ref_table: "supplier_payments",
      ref_id: payment.id,
      ref_no: refNo,
      debit: 0,
      credit: total_settled,
      narration: cleanStr(narrationBase, 255),
    };

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
      message:
        discount_amount > 0
          ? "Payment + discount saved and ledger credited."
          : "Payment saved and ledger credited.",
      supplier,
      payment,
      settle: {
        cash_paid: amount,
        discount_amount,
        discount_percent,
        total_settled,
      },
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

    // ✅ your model uses payment_date
    if (fromD || toD) {
      where.payment_date = {};
      if (fromD) where.payment_date[Op.gte] = fromD.toISOString().slice(0, 10);
      if (toD) where.payment_date[Op.lte] = toD.toISOString().slice(0, 10);
    }

    const rows = await SupplierPayment.findAll({
      where,
      order: [
        ["payment_date", "DESC"],
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

    return reply.send({ supplier, payment });
  } catch (err) {
    request.log?.error?.(err);
    console.error("❌ supplier payment get error:", err);
    return reply.code(500).send({ error: "Failed to fetch payment" });
  }
};

/* ============================
   DELETE /api/suppliers/:supplierId/payments/:paymentId
   ALSO supports: /api/suppliers/payments/:paymentId
   ============================ */
exports.deletePayment = async (request, reply) => {
  const t = await sequelize.transaction();
  try {
    const paymentId = num(request.params?.paymentId);
    const supplierIdFromParams = num(request.params?.supplierId);

    if (!paymentId) {
      await t.rollback();
      return reply.code(400).send({ error: "Invalid paymentId" });
    }

    const payment = await SupplierPayment.findByPk(paymentId, { transaction: t });
    if (!payment) {
      await t.rollback();
      return reply.code(404).send({ error: "Payment not found" });
    }

    const supplierId = num(payment.supplier_id);

    if (supplierIdFromParams && supplierIdFromParams !== supplierId) {
      await t.rollback();
      return reply
        .code(400)
        .send({ error: "Payment does not belong to this supplier" });
    }

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
