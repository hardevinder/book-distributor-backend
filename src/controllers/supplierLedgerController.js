"use strict";

const { Op } = require("sequelize");
const { Supplier, SupplierLedgerTxn } = require("../models");

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

/**
 * GET /api/suppliers/:supplierId/balance
 * Returns: { supplier, debit_total, credit_total, balance }
 * balance = debit_total - credit_total
 */
exports.balance = async (request, reply) => {
  try {
    const supplierId = num(request.params?.supplierId);
    if (!supplierId) return reply.code(400).send({ error: "Invalid supplierId" });

    const supplier = await Supplier.findByPk(supplierId);
    if (!supplier) return reply.code(404).send({ error: "Supplier not found" });

    // faster than fetching all rows, uses SQL SUM
    const agg = await SupplierLedgerTxn.findAll({
      where: { supplier_id: supplierId },
      attributes: [
        [SupplierLedgerTxn.sequelize.fn("COALESCE", SupplierLedgerTxn.sequelize.fn("SUM", SupplierLedgerTxn.sequelize.col("debit")), 0), "debit_total"],
        [SupplierLedgerTxn.sequelize.fn("COALESCE", SupplierLedgerTxn.sequelize.fn("SUM", SupplierLedgerTxn.sequelize.col("credit")), 0), "credit_total"],
      ],
      raw: true,
    });

    const debit_total = round2(agg?.[0]?.debit_total);
    const credit_total = round2(agg?.[0]?.credit_total);
    const balance = round2(debit_total - credit_total);

    return reply.send({ supplier, debit_total, credit_total, balance });
  } catch (err) {
    request.log?.error?.(err);
    console.error("❌ supplier balance error:", err);
    return reply.code(500).send({ error: "Failed to fetch balance" });
  }
};

/**
 * GET /api/suppliers/:supplierId/ledger
 * Query: from?, to?, limit?
 * Returns: { supplier, txns, debit_total, credit_total, balance }
 */
exports.ledger = async (request, reply) => {
  try {
    const supplierId = num(request.params?.supplierId);
    if (!supplierId) return reply.code(400).send({ error: "Invalid supplierId" });

    const supplier = await Supplier.findByPk(supplierId);
    if (!supplier) return reply.code(404).send({ error: "Supplier not found" });

    const { from, to, limit } = request.query || {};

    const where = { supplier_id: supplierId };

    const fromD = safeDate(from);
    const toD = safeDate(to);

    if (fromD || toD) {
      where.txn_date = {};
      if (fromD) where.txn_date[Op.gte] = fromD;
      if (toD) where.txn_date[Op.lte] = toD;
    }

    const txns = await SupplierLedgerTxn.findAll({
      where,
      order: [["txn_date", "ASC"], ["id", "ASC"]],
      limit: Math.min(500, Math.max(1, num(limit) || 200)),
    });

    const debit_total = round2(txns.reduce((s, r) => s + num(r.debit), 0));
    const credit_total = round2(txns.reduce((s, r) => s + num(r.credit), 0));
    const balance = round2(debit_total - credit_total);

    // Running balance
    let running = 0;
    const txnsWithRunning = txns.map((t) => {
      running = round2(running + num(t.debit) - num(t.credit));
      return { ...t.toJSON(), running_balance: running };
    });

    return reply.send({
      supplier,
      txns: txnsWithRunning,
      debit_total,
      credit_total,
      balance,
    });
  } catch (err) {
    request.log?.error?.(err);
    console.error("❌ supplier ledger error:", err);
    return reply.code(500).send({ error: "Failed to fetch ledger" });
  }
};
