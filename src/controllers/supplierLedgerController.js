"use strict";

const { Op } = require("sequelize");
const { Supplier, SupplierLedgerTxn } = require("../models");

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n) => Math.round(num(n) * 100) / 100;

/**
 * Expect YYYY-MM-DD, convert to start/end of that day
 * so date filter includes full day properly.
 */
const parseDateStart = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00.000`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
};

const parseDateEnd = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T23:59:59.999`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
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

    // SQL SUM (fast)
    const agg = await SupplierLedgerTxn.findAll({
      where: { supplier_id: supplierId },
      attributes: [
        [
          SupplierLedgerTxn.sequelize.fn(
            "COALESCE",
            SupplierLedgerTxn.sequelize.fn("SUM", SupplierLedgerTxn.sequelize.col("debit")),
            0
          ),
          "debit_total",
        ],
        [
          SupplierLedgerTxn.sequelize.fn(
            "COALESCE",
            SupplierLedgerTxn.sequelize.fn("SUM", SupplierLedgerTxn.sequelize.col("credit")),
            0
          ),
          "credit_total",
        ],
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
 *
 * ✅ Totals are calculated using SQL SUM for the SAME date range
 * ✅ txns list is still limited by `limit`
 */
exports.ledger = async (request, reply) => {
  try {
    const supplierId = num(request.params?.supplierId);
    if (!supplierId) return reply.code(400).send({ error: "Invalid supplierId" });

    const supplier = await Supplier.findByPk(supplierId);
    if (!supplier) return reply.code(404).send({ error: "Supplier not found" });

    const { from, to, limit } = request.query || {};

    const where = { supplier_id: supplierId };

    const fromD = parseDateStart(from);
    const toD = parseDateEnd(to);

    if (fromD || toD) {
      where.txn_date = {};
      if (fromD) where.txn_date[Op.gte] = fromD;
      if (toD) where.txn_date[Op.lte] = toD;
    }

    const safeLimit = Math.min(500, Math.max(1, num(limit) || 200));

    // 1) Get txns (limited)
    const txns = await SupplierLedgerTxn.findAll({
      where,
      order: [
        ["txn_date", "ASC"],
        ["id", "ASC"],
      ],
      limit: safeLimit,
    });

    // 2) Totals for same filters (NOT affected by limit)
    const agg = await SupplierLedgerTxn.findAll({
      where,
      attributes: [
        [
          SupplierLedgerTxn.sequelize.fn(
            "COALESCE",
            SupplierLedgerTxn.sequelize.fn("SUM", SupplierLedgerTxn.sequelize.col("debit")),
            0
          ),
          "debit_total",
        ],
        [
          SupplierLedgerTxn.sequelize.fn(
            "COALESCE",
            SupplierLedgerTxn.sequelize.fn("SUM", SupplierLedgerTxn.sequelize.col("credit")),
            0
          ),
          "credit_total",
        ],
      ],
      raw: true,
    });

    const debit_total = round2(agg?.[0]?.debit_total);
    const credit_total = round2(agg?.[0]?.credit_total);
    const balance = round2(debit_total - credit_total);

    // Running balance (based on returned list)
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
