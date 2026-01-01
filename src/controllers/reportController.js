"use strict";

const { Op } = require("sequelize");
const {
  School,
  Supplier,
  Book,
  SchoolOrder,
  SchoolOrderItem,
  SupplierReceipt,
  SupplierReceiptItem,
} = require("../models");

/* ---------------- Helpers ---------------- */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const safeStr = (v) => String(v ?? "").trim();

const normalizeView = (v) => {
  const s = safeStr(v).toUpperCase();
  if (s === "RECEIVED") return "RECEIVED";
  if (s === "PENDING") return "PENDING";
  return "ALL";
};

const safeDate = (d) => {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
};

// ✅ makes YYYY-MM-DD "to" include full day
const endOfDay = (d) => {
  const dt = safeDate(d);
  if (!dt) return null;
  dt.setHours(23, 59, 59, 999);
  return dt;
};

/**
 * ✅ Find Sequelize association alias automatically
 */
function findAssocAlias(sourceModel, targetModel) {
  if (!sourceModel?.associations || !targetModel) return null;
  const assoc = Object.values(sourceModel.associations).find((a) => a?.target === targetModel);
  return assoc?.as || null;
}

/**
 * ✅ Safe include builder (only if alias exists)
 */
function buildInclude(sourceModel, targetModel, includeObj) {
  if (!sourceModel || !targetModel) return null;
  const as = findAssocAlias(sourceModel, targetModel);
  if (!as) return null;
  return { ...includeObj, model: targetModel, as };
}

/**
 * ORDER LINE NET (fallback if line_amount missing)
 */
function calcOrderItemNet(it) {
  const ordered = num(it.total_order_qty);
  const rate = it.unit_price != null ? num(it.unit_price) : 0;
  const gross = rate * ordered;

  const discPct = it.discount_pct != null ? num(it.discount_pct) : 0;
  const discAmt = it.discount_amt != null ? num(it.discount_amt) : 0;

  if (it.line_amount != null && num(it.line_amount) > 0) {
    return Math.max(0, num(it.line_amount));
  }

  let net = gross;
  if (discAmt > 0) net = Math.max(0, gross - discAmt);
  else if (discPct > 0) net = Math.max(0, gross - (gross * discPct) / 100);

  return Math.max(0, net);
}

/* ============================================================
 * GET /api/reports/school-supplier-billing
 * ============================================================ */
exports.schoolSupplierBilling = async (request, reply) => {
  try {
    const { schoolId, academic_session, supplierId, from, to, includeDraft, view } = request.query || {};

    const sId = Number(schoolId);
    if (!sId) return reply.code(400).send({ message: "schoolId is required" });

    const school = await School.findByPk(sId, { attributes: ["id", "name"] });
    if (!school) return reply.code(404).send({ message: "School not found" });

    const viewMode = normalizeView(view);
    const supplierFilterId = supplierId && Number(supplierId) ? Number(supplierId) : null;

    /* ------------------------------------------------------------
     * Resolve aliases dynamically
     * ------------------------------------------------------------ */
    const soSupplierAlias = findAssocAlias(SchoolOrder, Supplier) || "supplier";
    const soItemsAlias = findAssocAlias(SchoolOrder, SchoolOrderItem) || "items";
    const soiBookAlias = findAssocAlias(SchoolOrderItem, Book) || "book";

    const srSupplierAlias = findAssocAlias(SupplierReceipt, Supplier) || "supplier";
    const srItemsAlias = findAssocAlias(SupplierReceipt, SupplierReceiptItem) || "items";
    const sriBookAlias = findAssocAlias(SupplierReceiptItem, Book) || "book";
    const srSchoolOrderAlias = findAssocAlias(SupplierReceipt, SchoolOrder) || "schoolOrder";

    /* --------------------------------------------
     * 1) ORDERED baseline from SchoolOrder + items
     * -------------------------------------------- */
    const whereOrder = { school_id: sId };

    if (academic_session) whereOrder.academic_session = String(academic_session);

    /**
     * ✅ IMPORTANT FIX:
     * Do NOT hide draft orders by default in billing report,
     * because receipts can be posted while order remains draft.
     * We exclude only cancelled unless includeDraft=true is explicitly required for other screens.
     */
    if (!String(includeDraft || "").toLowerCase().includes("true")) {
      whereOrder.status = { [Op.ne]: "cancelled" };
    }

    if (supplierFilterId) whereOrder.supplier_id = supplierFilterId;

    // order_date filter for ORDERED side
    if (from || to) {
      whereOrder.order_date = {};
      if (from) whereOrder.order_date[Op.gte] = safeDate(from);
      if (to) whereOrder.order_date[Op.lte] = endOfDay(to);
    }

    const orderIncludes = [];

    const supInc = buildInclude(SchoolOrder, Supplier, {
      attributes: ["id", "name"],
      required: false,
    });
    if (supInc) orderIncludes.push(supInc);

    const itemsInc = buildInclude(SchoolOrder, SchoolOrderItem, {
      required: false,
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
      include: [],
    });

    if (itemsInc) {
      const bookInc = buildInclude(SchoolOrderItem, Book, {
        attributes: ["id", "title", "class_name", "subject", "code"],
        required: false,
      });

      if (bookInc) {
        itemsInc.include.push(bookInc);
      } else {
        itemsInc.include.push({
          model: Book,
          attributes: ["id", "title", "class_name", "subject", "code"],
          required: false,
        });
      }

      orderIncludes.push(itemsInc);
    }

    const orders = await SchoolOrder.findAll({
      where: whereOrder,
      attributes: ["id", "supplier_id", "order_no", "order_date", "academic_session", "status", "bill_no"],
      include: orderIncludes,
      order: [["order_date", "DESC"]],
    });

    const orderedKeyMap = new Map(); // key => agg

    for (const o of orders || []) {
      const supModel = o?.[soSupplierAlias] || o?.supplier;
      const supObj = supModel?.id
        ? { id: Number(supModel.id), name: supModel.name }
        : { id: Number(o.supplier_id), name: "Unknown Supplier" };

      const itemsArr = o?.[soItemsAlias] || o?.items || [];

      for (const it of itemsArr) {
        const bookModel = it?.[soiBookAlias] || it?.book || it?.Book || null;

        const bookId = num(it.book_id || bookModel?.id);
        if (!bookId) continue;

        const orderedQty = num(it.total_order_qty);
        if (orderedQty <= 0) continue;

        const rate = it.unit_price != null ? num(it.unit_price) : 0;
        const grossAmount = rate * orderedQty;

        const discPct = it.discount_pct != null ? num(it.discount_pct) : null;
        const discAmt = it.discount_amt != null ? num(it.discount_amt) : null;

        const netUnit =
          it.net_unit_price != null && num(it.net_unit_price) > 0
            ? num(it.net_unit_price)
            : orderedQty > 0
            ? calcOrderItemNet(it) / orderedQty
            : 0;

        const orderedNetAmount = calcOrderItemNet(it);

        const key = `${supObj.id}|${bookId}`;
        if (!orderedKeyMap.has(key)) {
          orderedKeyMap.set(key, {
            supplier: supObj,

            book_id: bookId,
            title: bookModel?.title || `Book #${bookId}`,
            class_name: bookModel?.class_name || "Unknown",
            subject: bookModel?.subject || null,
            code: bookModel?.code || null,

            last_order_id: o.id,
            last_order_no: o.order_no || "",
            last_order_date: o.order_date || null,
            last_status: o.status || "",
            last_bill_no: o.bill_no || null,
            last_academic_session: o.academic_session || null,

            ordered_qty: 0,
            _sum_rate_x_qty: 0,
            _sum_netUnit_x_qty: 0,

            gross_amount: 0,
            ordered_net_amount: 0,

            discount_pct: discPct,
            discount_amt: discAmt,
          });
        }

        const agg = orderedKeyMap.get(key);

        agg.ordered_qty += orderedQty;
        agg.gross_amount += grossAmount;
        agg.ordered_net_amount += orderedNetAmount;

        agg._sum_rate_x_qty += rate * orderedQty;
        agg._sum_netUnit_x_qty += netUnit * orderedQty;

        if (safeDate(o.order_date) && (!agg.last_order_date || safeDate(o.order_date) > safeDate(agg.last_order_date))) {
          agg.last_order_id = o.id;
          agg.last_order_no = o.order_no || "";
          agg.last_order_date = o.order_date || null;
          agg.last_status = o.status || "";
          agg.last_bill_no = o.bill_no || null;
          agg.last_academic_session = o.academic_session || null;
        }
      }
    }

    /* --------------------------------------------
     * 2) RECEIVED from SupplierReceipt + items
     * -------------------------------------------- */
    const receiptWhere = { status: "received" };
    if (supplierFilterId) receiptWhere.supplier_id = supplierFilterId;

    const soWhere = { school_id: sId };
    if (academic_session) soWhere.academic_session = String(academic_session);

    if (from || to) {
      receiptWhere.received_date = {};
      if (from) receiptWhere.received_date[Op.gte] = String(from);
      if (to) receiptWhere.received_date[Op.lte] = String(to);
    }

    const receiptIncludes = [];

    const rSupInc = buildInclude(SupplierReceipt, Supplier, {
      attributes: ["id", "name"],
      required: false,
    });
    if (rSupInc) receiptIncludes.push(rSupInc);

    const rSoInc = buildInclude(SupplierReceipt, SchoolOrder, {
      attributes: ["id", "school_id", "supplier_id", "order_no", "order_date", "bill_no", "academic_session", "status"],
      where: soWhere,
      required: true,
    });
    if (rSoInc) receiptIncludes.push(rSoInc);

    const rItemsInc = buildInclude(SupplierReceipt, SupplierReceiptItem, {
      required: true,
      attributes: ["book_id", "qty", "rate", "discount_amount", "net_amount"],
      include: [],
    });
    if (rItemsInc) {
      const rbInc = buildInclude(SupplierReceiptItem, Book, {
        attributes: ["id", "title", "class_name", "subject", "code"],
        required: false,
      });
      if (rbInc) {
        rItemsInc.include.push(rbInc);
      } else {
        rItemsInc.include.push({
          model: Book,
          attributes: ["id", "title", "class_name", "subject", "code"],
          required: false,
        });
      }
      receiptIncludes.push(rItemsInc);
    }

    const receipts = await SupplierReceipt.findAll({
      where: receiptWhere,
      attributes: [
        "id",
        "supplier_id",
        "school_order_id",
        "receipt_no",
        "received_date",
        "receive_doc_type",
        "doc_no",
        "doc_date",
        "grand_total",
      ],
      include: receiptIncludes,
      order: [["id", "DESC"]],
    });

    const receivedKeyMap = new Map();
    for (const r of receipts || []) {
      const supModel = r?.[srSupplierAlias] || r?.supplier;
      const supObj = supModel?.id
        ? { id: Number(supModel.id), name: supModel.name }
        : { id: Number(r.supplier_id), name: "Unknown Supplier" };

      const itemsArr = r?.[srItemsAlias] || r?.items || [];

      for (const it of itemsArr) {
        const bookModel = it?.[sriBookAlias] || it?.book || it?.Book || null;
        const bookId = num(it.book_id || bookModel?.id);
        if (!bookId) continue;

        const qty = num(it.qty);
        if (qty <= 0) continue;

        const rate = it.rate != null ? num(it.rate) : 0;
        const netAmount = it.net_amount != null ? num(it.net_amount) : rate * qty;
        const netUnit = qty > 0 ? netAmount / qty : 0;

        const key = `${supObj.id}|${bookId}`;
        if (!receivedKeyMap.has(key)) {
          receivedKeyMap.set(key, {
            received_qty: 0,
            received_net_amount: 0,
            _sum_rate_x_qty: 0,
            _sum_netUnit_x_qty: 0,
            bookMeta: bookModel
              ? {
                  title: bookModel.title,
                  class_name: bookModel.class_name,
                  subject: bookModel.subject,
                  code: bookModel.code,
                }
              : null,
          });
        }

        const agg = receivedKeyMap.get(key);
        agg.received_qty += qty;
        agg.received_net_amount += netAmount;
        agg._sum_rate_x_qty += rate * qty;
        agg._sum_netUnit_x_qty += netUnit * qty;

        if (!agg.bookMeta && bookModel) {
          agg.bookMeta = {
            title: bookModel.title,
            class_name: bookModel.class_name,
            subject: bookModel.subject,
            code: bookModel.code,
          };
        }
      }
    }

    /* --------------------------------------------
     * 3) Build finalBookRows
     * -------------------------------------------- */
    const finalBookRows = [];

    for (const [key, oAgg] of orderedKeyMap.entries()) {
      const rec = receivedKeyMap.get(key) || {
        received_qty: 0,
        received_net_amount: 0,
        _sum_rate_x_qty: 0,
        _sum_netUnit_x_qty: 0,
        bookMeta: null,
      };

      const orderedQty = num(oAgg.ordered_qty);
      const receivedQty = num(rec.received_qty);
      const pendingQty = Math.max(0, orderedQty - receivedQty);

      const orderedNet = num(oAgg.ordered_net_amount);
      const receivedNet = num(rec.received_net_amount);
      const pendingNet = Math.max(0, orderedNet - receivedNet);

      const avgRate =
        orderedQty > 0
          ? num(oAgg._sum_rate_x_qty) / orderedQty
          : receivedQty > 0
          ? num(rec._sum_rate_x_qty) / receivedQty
          : 0;

      const netUnit =
        orderedQty > 0
          ? num(oAgg._sum_netUnit_x_qty) / orderedQty
          : receivedQty > 0
          ? num(rec._sum_netUnit_x_qty) / receivedQty
          : 0;

      const grossAmount = num(oAgg.gross_amount) > 0 ? num(oAgg.gross_amount) : avgRate * orderedQty;

      finalBookRows.push({
        order_id: oAgg.last_order_id || 0,
        order_no: oAgg.last_order_no || "",
        order_date: oAgg.last_order_date || null,
        academic_session: oAgg.last_academic_session || academic_session || null,
        status: oAgg.last_status || "mixed",
        bill_no: oAgg.last_bill_no || null,

        supplier: oAgg.supplier,

        book_id: oAgg.book_id,
        title: oAgg.title,
        class_name: oAgg.class_name,
        subject: oAgg.subject,
        code: oAgg.code,

        ordered_qty: orderedQty,
        received_qty: receivedQty,
        pending_qty: pendingQty,

        rate: avgRate,
        gross_amount: grossAmount,
        discount_pct: oAgg.discount_pct ?? null,
        discount_amt: oAgg.discount_amt ?? null,
        net_unit_price: netUnit,

        ordered_net_amount: orderedNet,
        received_net_amount: receivedNet,
        pending_net_amount: pendingNet,
      });
    }

    if (viewMode === "RECEIVED" || viewMode === "ALL") {
      for (const [key, recAgg] of receivedKeyMap.entries()) {
        if (orderedKeyMap.has(key)) continue;

        const [supIdStr, bookIdStr] = String(key).split("|");
        const supId = Number(supIdStr);
        const bookId = Number(bookIdStr);

        const sName =
          (receipts || []).find((x) => Number(x.supplier_id) === supId)?.[srSupplierAlias]?.name ||
          (receipts || []).find((x) => Number(x.supplier_id) === supId)?.supplier?.name ||
          "Unknown Supplier";

        const receivedQty = num(recAgg.received_qty);
        const receivedNet = num(recAgg.received_net_amount);

        const avgRate = receivedQty > 0 ? num(recAgg._sum_rate_x_qty) / receivedQty : 0;
        const netUnit = receivedQty > 0 ? num(recAgg._sum_netUnit_x_qty) / receivedQty : 0;

        const bm = recAgg.bookMeta || null;

        finalBookRows.push({
          order_id: 0,
          order_no: "",
          order_date: null,
          academic_session: academic_session || null,
          status: "received",
          bill_no: null,

          supplier: { id: supId, name: sName },

          book_id: bookId,
          title: bm?.title || `Book #${bookId}`,
          class_name: bm?.class_name || "Unknown",
          subject: bm?.subject || null,
          code: bm?.code || null,

          ordered_qty: 0,
          received_qty: receivedQty,
          pending_qty: 0,

          rate: avgRate,
          gross_amount: 0,
          discount_pct: null,
          discount_amt: null,
          net_unit_price: netUnit,

          ordered_net_amount: 0,
          received_net_amount: receivedNet,
          pending_net_amount: 0,
        });
      }
    }

    /* --------------------------------------------
     * 4) Apply view filter
     * -------------------------------------------- */
    const viewFiltered = finalBookRows.filter((r) => {
      if (viewMode === "RECEIVED") return num(r.received_qty) > 0 || num(r.received_net_amount) > 0;
      if (viewMode === "PENDING") return num(r.pending_qty) > 0 || num(r.pending_net_amount) > 0;
      return true;
    });

    /* --------------------------------------------
     * 5) Group: supplier -> class -> books + totals
     * -------------------------------------------- */
    const supMap = new Map();

    for (const r of viewFiltered) {
      const supKey = r.supplier?.id ? String(r.supplier.id) : "0";
      if (!supMap.has(supKey)) supMap.set(supKey, { supplier: r.supplier, classMap: new Map() });

      const holder = supMap.get(supKey);
      const clsName = r.class_name || "Unknown";
      if (!holder.classMap.has(clsName)) holder.classMap.set(clsName, []);
      holder.classMap.get(clsName).push(r);
    }

    const suppliers = Array.from(supMap.values()).map((s) => {
      const classes = Array.from(s.classMap.entries())
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }))
        .map(([class_name, books]) => {
          const sortedBooks = (books || []).sort((x, y) => String(x.title || "").localeCompare(String(y.title || "")));

          let orderedQty = 0,
            receivedQty = 0,
            pendingQty = 0,
            gross = 0,
            orderedNet = 0,
            receivedNet = 0,
            pendingNet = 0;

          for (const b of sortedBooks) {
            orderedQty += num(b.ordered_qty);
            receivedQty += num(b.received_qty);
            pendingQty += num(b.pending_qty);

            gross += num(b.gross_amount);

            orderedNet += num(b.ordered_net_amount);
            receivedNet += num(b.received_net_amount);
            pendingNet += num(b.pending_net_amount);
          }

          return {
            class_name,
            totals: { orderedQty, receivedQty, pendingQty, gross, orderedNet, receivedNet, pendingNet },
            books: sortedBooks,
          };
        });

      let orderedQty = 0,
        receivedQty = 0,
        pendingQty = 0,
        gross = 0,
        orderedNet = 0,
        receivedNet = 0,
        pendingNet = 0;

      for (const c of classes) {
        orderedQty += num(c.totals.orderedQty);
        receivedQty += num(c.totals.receivedQty);
        pendingQty += num(c.totals.pendingQty);

        gross += num(c.totals.gross);

        orderedNet += num(c.totals.orderedNet);
        receivedNet += num(c.totals.receivedNet);
        pendingNet += num(c.totals.pendingNet);
      }

      return {
        supplier: s.supplier,
        totals: { orderedQty, receivedQty, pendingQty, gross, orderedNet, receivedNet, pendingNet },
        classes,
      };
    });

    let orderedQty = 0,
      receivedQty = 0,
      pendingQty = 0,
      gross = 0,
      orderedNet = 0,
      receivedNet = 0,
      pendingNet = 0;

    for (const s of suppliers) {
      orderedQty += num(s.totals.orderedQty);
      receivedQty += num(s.totals.receivedQty);
      pendingQty += num(s.totals.pendingQty);

      gross += num(s.totals.gross);

      orderedNet += num(s.totals.orderedNet);
      receivedNet += num(s.totals.receivedNet);
      pendingNet += num(s.totals.pendingNet);
    }

    return reply.send({
      mode: "SCHOOL_SUPPLIER_BILLING",
      school: school.toJSON ? school.toJSON() : school,
      academic_session: academic_session || null,
      filters: {
        supplierId: supplierFilterId,
        from: from || null,
        to: to || null,
        includeDraft: String(includeDraft || "").toLowerCase().includes("true"),
        view: viewMode,
      },
      totals: {
        orderedQty,
        receivedQty,
        pendingQty,
        gross,
        orderedNet,
        receivedNet,
        pendingNet,
      },
      suppliers,
    });
  } catch (err) {
    request.log?.error?.(err);
    console.error("❌ schoolSupplierBilling error:", err);
    return reply.code(500).send({
      message: "Internal Server Error",
      details: err?.message || String(err),
    });
  }
};
