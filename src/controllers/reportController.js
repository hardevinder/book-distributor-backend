"use strict";

const { Op } = require("sequelize");
const { SchoolOrder, SchoolOrderItem, School, Book, Supplier } = require("../models");

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * GET /api/reports/school-supplier-billing
 * Query:
 *  - schoolId (required)
 *  - academic_session (optional)
 *  - supplierId (optional)
 *  - from (optional, YYYY-MM-DD)
 *  - to (optional, YYYY-MM-DD)
 *  - includeDraft=true (optional)
 */
exports.schoolSupplierBilling = async (request, reply) => {
  try {
    const { schoolId, academic_session, supplierId, from, to, includeDraft } = request.query || {};
    const sId = Number(schoolId);

    if (!sId) return reply.code(400).send({ message: "schoolId is required" });

    const school = await School.findByPk(sId, { attributes: ["id", "name"] });
    if (!school) return reply.code(404).send({ message: "School not found" });

    const whereOrder = { school_id: sId };

    if (academic_session) whereOrder.academic_session = String(academic_session);

    // ✅ status filter
    if (!String(includeDraft || "").toLowerCase().includes("true")) {
      whereOrder.status = { [Op.ne]: "draft" };
    }

    // ✅ supplier filter
    if (supplierId && Number(supplierId)) {
      whereOrder.supplier_id = Number(supplierId);
    }

    // ✅ date filters
    if (from || to) {
      whereOrder.order_date = {};
      if (from) whereOrder.order_date[Op.gte] = new Date(from);
      if (to) whereOrder.order_date[Op.lte] = new Date(to);
    }

    const orders = await SchoolOrder.findAll({
      where: whereOrder,
      attributes: [
        "id",
        "supplier_id",
        "order_no",
        "order_date",
        "academic_session",
        "status",
        "bill_no",
        "freight_charges",
        "packing_charges",
        "other_charges",
        "overall_discount",
        "round_off",
        "grand_total",
      ],
      include: [
        {
          model: Supplier,
          as: "supplier",
          attributes: ["id", "name"],
          required: false,
        },
        {
          model: SchoolOrderItem,
          as: "items",
          attributes: [
            "id",
            "book_id",
            "total_order_qty",
            "received_qty",
            "unit_price",
            "discount_pct",
            "discount_amt",
            "net_unit_price",
            "line_amount",
          ],
          include: [
            {
              model: Book,
              as: "book",
              attributes: ["id", "title", "class_name", "subject", "code"],
              required: true,
            },
          ],
          required: false,
        },
      ],
      order: [["order_date", "DESC"]],
    });

    // Flatten rows
    const rows = [];
    for (const o of orders) {
      const supObj = o.supplier
        ? { id: Number(o.supplier.id), name: o.supplier.name }
        : { id: Number(o.supplier_id), name: "Unknown Supplier" };

      for (const it of o.items || []) {
        const b = it.book;
        if (!b) continue;

        const ordered = num(it.total_order_qty);
        const received = num(it.received_qty);
        const short = Math.max(0, ordered - received);

        const rate = it.unit_price != null ? num(it.unit_price) : 0;
        const gross = rate * ordered;

        const discPct = it.discount_pct != null ? num(it.discount_pct) : null;
        const discAmt = it.discount_amt != null ? num(it.discount_amt) : null;

        // Prefer stored line_amount; else compute
        let net = it.line_amount != null ? num(it.line_amount) : gross;

        if (it.line_amount == null) {
          if (discAmt != null && discAmt > 0) net = Math.max(0, gross - discAmt);
          else if (discPct != null && discPct > 0) net = Math.max(0, gross - (gross * discPct) / 100);
        }

        rows.push({
          order_id: o.id,
          order_no: o.order_no,
          order_date: o.order_date,
          academic_session: o.academic_session || null,
          status: o.status,
          bill_no: o.bill_no || null,

          supplier: supObj,

          book_id: b.id,
          title: b.title,
          class_name: b.class_name || "Unknown",
          subject: b.subject || null,
          code: b.code || null,

          ordered_qty: ordered,
          received_qty: received,
          short_qty: short,

          rate,
          gross_amount: gross,
          discount_pct: discPct,
          discount_amt: discAmt,
          net_amount: net,
        });
      }
    }

    // Group: supplier -> class -> books
    const supMap = new Map();
    for (const r of rows) {
      const supKey = r.supplier?.id ? String(r.supplier.id) : "0";
      if (!supMap.has(supKey)) supMap.set(supKey, { supplier: r.supplier, classMap: new Map() });

      const holder = supMap.get(supKey);
      if (!holder.classMap.has(r.class_name)) holder.classMap.set(r.class_name, []);
      holder.classMap.get(r.class_name).push(r);
    }

    const suppliers = Array.from(supMap.values()).map((s) => {
      const classes = Array.from(s.classMap.entries())
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }))
        .map(([class_name, books]) => ({
          class_name,
          books: books.sort((x, y) => String(x.title || "").localeCompare(String(y.title || ""))),
        }));

      let orderedTotal = 0,
        receivedTotal = 0,
        shortTotal = 0,
        grossTotal = 0,
        netTotal = 0;

      for (const c of classes) {
        for (const b of c.books) {
          orderedTotal += num(b.ordered_qty);
          receivedTotal += num(b.received_qty);
          shortTotal += num(b.short_qty);
          grossTotal += num(b.gross_amount);
          netTotal += num(b.net_amount);
        }
      }

      return {
        supplier: s.supplier,
        totals: { orderedTotal, receivedTotal, shortTotal, grossTotal, netTotal },
        classes,
      };
    });

    // overall totals
    let orderedTotal = 0,
      receivedTotal = 0,
      shortTotal = 0,
      grossTotal = 0,
      netTotal = 0;

    for (const s of suppliers) {
      orderedTotal += s.totals.orderedTotal;
      receivedTotal += s.totals.receivedTotal;
      shortTotal += s.totals.shortTotal;
      grossTotal += s.totals.grossTotal;
      netTotal += s.totals.netTotal;
    }

    return reply.send({
      mode: "SCHOOL_SUPPLIER_BILLING",
      school,
      academic_session: academic_session || null,
      filters: {
        supplierId: supplierId ? Number(supplierId) : null,
        from: from || null,
        to: to || null,
      },
      totals: { orderedTotal, receivedTotal, shortTotal, grossTotal, netTotal },
      suppliers,
    });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ message: "Internal Server Error" });
  }
};
