"use strict";

const { Op } = require("sequelize");

const {
  sequelize, // (kept, even if not used yet)

  Sale,
  SaleItem,

  Product,
  Book,
  School,
  Distributor,
  Bundle, // (kept, even if not used yet)

  InventoryBatch, // (kept, even if not used yet)
  InventoryTxn, // (kept, even if not used yet)

  User, // ✅ seller
} = require("../models");

/* =========================
   Helpers
   ========================= */

/**
 * IMPORTANT:
 * Your DB/User role enum (as per your User model) is:
 *   superadmin, distributor, school, staff
 *
 * So keep admin roles aligned with that.
 */
const ADMINISH_ROLES = ["SUPERADMIN", "STAFF"];

const num = (v) => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^\d.-]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n) => Math.round(num(n) * 100) / 100;
const safeText = (v) => String(v ?? "").trim();
const parseDate = (v) => (v ? String(v).slice(0, 10) : null);

function getUserRoles(user) {
  const r = user?.roles ?? user?.role ?? [];
  if (Array.isArray(r)) return r.map((x) => String(x).toUpperCase());
  return [String(r).toUpperCase()];
}

function hasAnyRole(user, roles) {
  const mine = getUserRoles(user);
  return roles.some((r) => mine.includes(String(r).toUpperCase()));
}

function buildDateWhere(from, to) {
  const where = {};
  if (from && to) where.sale_date = { [Op.between]: [from, to] };
  else if (from) where.sale_date = { [Op.gte]: from };
  else if (to) where.sale_date = { [Op.lte]: to };
  return where;
}

function assertAdminish(request) {
  if (!request?.user) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
  if (!hasAnyRole(request.user, ADMINISH_ROLES)) {
    const err = new Error("Forbidden (admin only)");
    err.statusCode = 403;
    throw err;
  }
}

/** Seller->Distributor resolver
 * ✅ Works when:
 * - User has distributor_id column
 * OR
 * - User belongsTo Distributor as "distributor"
 */
async function getDistributorIdFromSaleCreator(saleCreator) {
  if (!saleCreator) return 0;

  const did = num(
    saleCreator.distributor_id ||
      saleCreator.distributorId ||
      saleCreator.DistributorId
  );
  if (did) return did;

  // if creator has included distributor association
  const nested = num(saleCreator.distributor?.id || saleCreator.Distributor?.id);
  return nested || 0;
}

/* ============================================================
   SALES ANALYTICS CONTROLLER (Admin)
   File: controllers/salesAnalyticsController.js
   ============================================================ */

/**
 * ✅ 1) Distributor -> School Summary (includes CREDIT outstanding)
 * GET /api/sales-analytics/distributor-school-summary
 */
exports.distributorSchoolSummary = async (request, reply) => {
  try {
    assertAdminish(request);

    const q = request.query || {};
    const from = parseDate(q.from);
    const to = parseDate(q.to);

    const where = {
      ...buildDateWhere(from, to),
      sold_to_type: "SCHOOL",
      status: safeText(q.status || "COMPLETED").toUpperCase(),
    };

    if (q.school_id) where.sold_to_id = num(q.school_id);
    if (q.payment_mode) where.payment_mode = safeText(q.payment_mode).toUpperCase();

    const rows = await Sale.findAll({
      where,
      include: [
        {
          model: School,
          as: "soldSchool",
          attributes: ["id", "name", "city"],
          required: true,
        },
        {
          model: User,
          as: "creator",
          // ✅ FIX: removed "username" (column doesn't exist)
          attributes: ["id", "name", "email", "phone", "role", "distributor_id"],
          required: true,
          include: [
            {
              model: Distributor,
              as: "distributor",
              attributes: ["id", "name", "mobile", "city"],
              required: false,
            },
          ],
        },
      ],
      attributes: [
        "id",
        "sold_to_id",
        "payment_mode",
        "total_amount",
        "paid_amount",
        "balance_amount",
        "sale_date",
      ],
      order: [["id", "DESC"]],
    });

    const map = new Map();

    for (const r of rows) {
      const row = r.toJSON();
      const creator = row.creator || null;
      const did = await getDistributorIdFromSaleCreator(creator);

      // Optional distributor filter
      if (q.distributor_id && did !== num(q.distributor_id)) continue;

      const school = row.soldSchool;
      const key = `${did}::${school?.id || 0}`;

      if (!map.has(key)) {
        map.set(key, {
          distributor_id: did || null,
          distributor: creator?.distributor || (did ? { id: did } : null),
          school,
          sales_count: 0,
          total_amount: 0,
          paid_amount: 0,
          balance_amount: 0,
          split: {
            CASH: 0,
            UPI: 0,
            CARD: 0,
            CREDIT: 0,
            MIXED: 0,
          },
          credit: {
            credit_sales_total: 0,
            credit_paid_total: 0,
            credit_balance_total: 0,
          },
        });
      }

      const acc = map.get(key);
      const mode = safeText(row.payment_mode).toUpperCase();

      acc.sales_count += 1;
      acc.total_amount = round2(acc.total_amount + num(row.total_amount));
      acc.paid_amount = round2(acc.paid_amount + num(row.paid_amount));
      acc.balance_amount = round2(acc.balance_amount + num(row.balance_amount));

      acc.split[mode] = round2(num(acc.split[mode]) + num(row.total_amount));

      if (mode === "CREDIT") {
        acc.credit.credit_sales_total = round2(
          acc.credit.credit_sales_total + num(row.total_amount)
        );
        acc.credit.credit_paid_total = round2(
          acc.credit.credit_paid_total + num(row.paid_amount)
        );
        acc.credit.credit_balance_total = round2(
          acc.credit.credit_balance_total + num(row.balance_amount)
        );
      }
    }

    const out = Array.from(map.values()).sort(
      (a, b) => num(b.total_amount) - num(a.total_amount)
    );
    return reply.send({ from, to, rows: out });
  } catch (err) {
    request.log.error({ err }, "salesAnalytics distributorSchoolSummary failed");
    return reply
      .code(err.statusCode || 500)
      .send({ message: err?.message || "Internal Server Error" });
  }
};

/**
 * ✅ 2) Distributor -> School -> Item Summary (qty + amount)
 * GET /api/sales-analytics/distributor-school-items
 */
exports.distributorSchoolItems = async (request, reply) => {
  try {
    assertAdminish(request);

    const q = request.query || {};
    const from = parseDate(q.from);
    const to = parseDate(q.to);

    const saleWhere = {
      ...buildDateWhere(from, to),
      sold_to_type: "SCHOOL",
      status: safeText(q.status || "COMPLETED").toUpperCase(),
    };

    if (q.school_id) saleWhere.sold_to_id = num(q.school_id);

    const sales = await Sale.findAll({
      where: saleWhere,
      include: [
        {
          model: User,
          as: "creator",
          attributes: ["id", "distributor_id", "email", "role"],
          required: true,
          include: [
            {
              model: Distributor,
              as: "distributor",
              attributes: ["id", "name"],
              required: false,
            },
          ],
        },
      ],
      attributes: ["id", "sold_to_id"],
      order: [["id", "DESC"]],
    });

    const saleIds = [];
    const saleMeta = new Map(); // sale_id -> { distributor_id, school_id }

    for (const s of sales) {
      const sj = s.toJSON();
      const did = await getDistributorIdFromSaleCreator(sj.creator);

      if (q.distributor_id && did !== num(q.distributor_id)) continue;

      saleIds.push(sj.id);
      saleMeta.set(sj.id, {
        distributor_id: did,
        school_id: num(sj.sold_to_id),
      });
    }

    if (!saleIds.length) return reply.send({ from, to, rows: [] });

    const itemWhere = { sale_id: { [Op.in]: saleIds } };
    if (q.kind) itemWhere.kind = safeText(q.kind).toUpperCase();

    const items = await SaleItem.findAll({
      where: itemWhere,
      include: [
        { model: Product, as: "product", attributes: ["id", "type"], required: false },
        { model: Book, as: "book", attributes: ["id", "title", "class_name"], required: false },
      ],
      order: [["id", "ASC"]],
    });

    // School lookup (batch)
    const schoolIds = Array.from(
      new Set(sales.map((s) => num(s.sold_to_id)).filter((x) => x > 0))
    );
    const schools = await School.findAll({
      where: { id: { [Op.in]: schoolIds } },
      attributes: ["id", "name", "city"],
    });
    const schoolMap = new Map(schools.map((s) => [num(s.id), s.toJSON()]));

    const map = new Map();

    for (const it of items) {
      const ij = it.toJSON();
      const meta = saleMeta.get(num(ij.sale_id));
      if (!meta) continue;

      const distributor_id = meta.distributor_id || 0;
      const school_id = meta.school_id || 0;

      const title = safeText(ij.title_snapshot) || safeText(ij.book?.title) || "Item";
      const cls = safeText(ij.class_name_snapshot) || safeText(ij.book?.class_name) || null;
      const kind = safeText(ij.kind).toUpperCase();

      const key = `${distributor_id}::${school_id}::${num(ij.product_id)}::${kind}::${title}::${cls || ""}`;

      if (!map.has(key)) {
        map.set(key, {
          distributor_id: distributor_id || null,
          school: schoolMap.get(school_id) || (school_id ? { id: school_id } : null),
          product_id: num(ij.product_id) || null,
          kind,
          title,
          class_name: cls,
          total_qty: 0,
          total_amount: 0,
          issued_qty: 0,
          short_qty: 0,
        });
      }

      const acc = map.get(key);

      acc.total_qty = round2(acc.total_qty + num(ij.requested_qty ?? ij.qty));
      acc.total_amount = round2(acc.total_amount + num(ij.amount));

      acc.issued_qty = round2(acc.issued_qty + num(ij.issued_qty));
      acc.short_qty = round2(acc.short_qty + num(ij.short_qty));
    }

    const out = Array.from(map.values()).sort(
      (a, b) => num(b.total_amount) - num(a.total_amount)
    );
    return reply.send({ from, to, rows: out });
  } catch (err) {
    request.log.error({ err }, "salesAnalytics distributorSchoolItems failed");
    return reply
      .code(err.statusCode || 500)
      .send({ message: err?.message || "Internal Server Error" });
  }
};

/**
 * ✅ 3) Distributor -> School Sales Drilldown
 * GET /api/sales-analytics/distributor-school-sales
 */
exports.distributorSchoolSales = async (request, reply) => {
  try {
    assertAdminish(request);

    const q = request.query || {};
    const from = parseDate(q.from);
    const to = parseDate(q.to);

    const where = {
      ...buildDateWhere(from, to),
      sold_to_type: "SCHOOL",
      status: safeText(q.status || "COMPLETED").toUpperCase(),
    };

    if (q.school_id) where.sold_to_id = num(q.school_id);
    if (q.payment_mode) where.payment_mode = safeText(q.payment_mode).toUpperCase();
    if (q.phone) where.phone = { [Op.like]: `%${safeText(q.phone)}%` };

    const limit = Math.min(2000, Math.max(1, num(q.limit) || 500));

    const rows = await Sale.findAll({
      where,
      include: [
        {
          model: School,
          as: "soldSchool",
          attributes: ["id", "name", "city"],
          required: true,
        },
        {
          model: User,
          as: "creator",
          // ✅ FIX: removed "username"
          attributes: ["id", "name", "email", "phone", "role", "distributor_id"],
          required: true,
          include: [
            {
              model: Distributor,
              as: "distributor",
              attributes: ["id", "name", "mobile", "city"],
              required: false,
            },
          ],
        },
      ],
      attributes: [
        "id",
        "sale_no",
        "sale_date",
        "status",
        "payment_mode",
        "subtotal",
        "discount",
        "tax",
        "total_amount",
        "paid_amount",
        "balance_amount",

        "bill_to_name",
        "parent_name",
        "phone",
        "reference_by",
        "reference_phone",

        "created_by",
      ],
      order: [["id", "DESC"]],
      limit,
    });

    const out = [];
    for (const r of rows) {
      const j = r.toJSON();
      const did = await getDistributorIdFromSaleCreator(j.creator);

      if (q.distributor_id && did !== num(q.distributor_id)) continue;

      out.push({
        id: j.id,
        sale_no: j.sale_no,
        sale_date: j.sale_date,
        status: j.status,
        payment_mode: j.payment_mode,

        totals: {
          subtotal: round2(num(j.subtotal)),
          discount: round2(num(j.discount)),
          tax: round2(num(j.tax)),
          total_amount: round2(num(j.total_amount)),
          paid_amount: round2(num(j.paid_amount)),
          balance_amount: round2(num(j.balance_amount)),
        },

        school: j.soldSchool,
        distributor_id: did || null,
        distributor: j.creator?.distributor || (did ? { id: did } : null),
        sold_by: j.creator
          ? {
              id: j.creator.id,
              name: j.creator.name || null,
              // ✅ No username column in DB; use email as identifier
              username: j.creator.email || null,
              email: j.creator.email || null,
              phone: j.creator.phone || null,
              role: j.creator.role || null,
            }
          : null,

        bill_to_name: j.bill_to_name || null,
        parent_name: j.parent_name || null,
        phone: j.phone || null,
        reference_by: j.reference_by || null,
        reference_phone: j.reference_phone || null,
      });
    }

    return reply.send({ from, to, rows: out });
  } catch (err) {
    request.log.error({ err }, "salesAnalytics distributorSchoolSales failed");
    return reply
      .code(err.statusCode || 500)
      .send({ message: err?.message || "Internal Server Error" });
  }
};

/**
 * ✅ 4) CREDIT OUTSTANDING (Student wise)
 * GET /api/sales-analytics/credit-outstanding
 */
exports.creditOutstanding = async (request, reply) => {
  try {
    assertAdminish(request);

    const q = request.query || {};
    const from = parseDate(q.from);
    const to = parseDate(q.to);

    const where = {
      ...buildDateWhere(from, to),
      sold_to_type: "SCHOOL",
      payment_mode: "CREDIT",
      status: safeText(q.status || "COMPLETED").toUpperCase(),
    };

    if (q.school_id) where.sold_to_id = num(q.school_id);
    if (q.phone) where.phone = { [Op.like]: `%${safeText(q.phone)}%` };

    const sales = await Sale.findAll({
      where,
      include: [
        {
          model: School,
          as: "soldSchool",
          attributes: ["id", "name", "city"],
          required: true,
        },
        {
          model: User,
          as: "creator",
          // ✅ FIX: removed "username"
          attributes: ["id", "name", "email", "phone", "role", "distributor_id"],
          required: true,
          include: [
            {
              model: Distributor,
              as: "distributor",
              attributes: ["id", "name", "mobile", "city"],
              required: false,
            },
          ],
        },
      ],
      attributes: [
        "id",
        "sale_no",
        "sale_date",
        "sold_to_id",
        "total_amount",
        "paid_amount",
        "balance_amount",

        "bill_to_name",
        "parent_name",
        "phone",
        "reference_by",
        "reference_phone",
      ],
      order: [["id", "DESC"]],
    });

    const map = new Map();

    for (const s of sales) {
      const j = s.toJSON();
      const did = await getDistributorIdFromSaleCreator(j.creator);

      if (q.distributor_id && did !== num(q.distributor_id)) continue;

      const school = j.soldSchool;
      const bill = safeText(j.bill_to_name) || "(No Name)";
      const ph = safeText(j.phone) || "(No Phone)";

      const key = `${did}::${school?.id || 0}::${bill}::${ph}`;

      if (!map.has(key)) {
        map.set(key, {
          distributor_id: did || null,
          distributor: j.creator?.distributor || (did ? { id: did } : null),
          school,
          bill_to_name: j.bill_to_name || null,
          parent_name: j.parent_name || null,
          phone: j.phone || null,
          reference_by: j.reference_by || null,
          reference_phone: j.reference_phone || null,

          sales_count: 0,
          last_sale_date: j.sale_date || null,

          total_credit: 0,
          paid_total: 0,
          balance_total: 0,
        });
      }

      const acc = map.get(key);

      acc.sales_count += 1;
      if (!acc.last_sale_date || String(j.sale_date) > String(acc.last_sale_date)) {
        acc.last_sale_date = j.sale_date;
      }

      acc.total_credit = round2(acc.total_credit + num(j.total_amount));
      acc.paid_total = round2(acc.paid_total + num(j.paid_amount));
      acc.balance_total = round2(acc.balance_total + num(j.balance_amount));
    }

    const minBal = q.min_balance != null ? num(q.min_balance) : null;

    let out = Array.from(map.values());
    if (minBal != null) out = out.filter((x) => num(x.balance_total) >= minBal);

    out.sort((a, b) => num(b.balance_total) - num(a.balance_total));

    return reply.send({ from, to, rows: out });
  } catch (err) {
    request.log.error({ err }, "salesAnalytics creditOutstanding failed");
    return reply
      .code(err.statusCode || 500)
      .send({ message: err?.message || "Internal Server Error" });
  }
};
