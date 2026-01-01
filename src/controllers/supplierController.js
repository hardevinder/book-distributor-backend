// src/controllers/supplierController.js
const {
  Supplier,
  Publisher,
  SupplierReceipt,
  SupplierReceiptItem,
  Book,
  // ✅ NEW (optional models - if exist in your project)
  School,
  SchoolOrder,
  sequelize,
} = require("../models");

/* ---------------- Helpers ---------------- */

const cleanStr = (v) => {
  if (v === undefined || v === null) return "";
  return String(v).trim();
};

const cleanNullable = (v) => {
  const s = cleanStr(v);
  return s ? s : null;
};

const toBool = (v, defaultValue = true) => {
  if (v === undefined || v === null || v === "") return defaultValue;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return defaultValue;
};

/**
 * ✅ Find Sequelize association alias automatically
 * Fixes: "associated to X using an alias. You must use 'as' keyword"
 */
function findAssocAlias(sourceModel, targetModel) {
  if (!sourceModel?.associations || !targetModel) return null;
  const assoc = Object.values(sourceModel.associations).find((a) => a?.target === targetModel);
  return assoc?.as || null;
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * ✅ Safe include builder (only if model + alias exists)
 */
function buildInclude(sourceModel, targetModel, includeObj) {
  if (!sourceModel || !targetModel) return null;
  const as = findAssocAlias(sourceModel, targetModel);
  if (!as) return null;
  return { ...includeObj, model: targetModel, as };
}

/**
 * ✅ Extract school from receipt JSON (supports different association shapes)
 */
function extractSchoolMeta({ receipt, schoolAlias, orderAlias, orderSchoolAlias }) {
  if (!receipt) return { school_id: null, school_name: null };

  // 1) Direct receipt -> School
  const direct = schoolAlias ? receipt[schoolAlias] : receipt.school || receipt.School;
  if (direct?.id || direct?.name) {
    return {
      school_id: direct.id ?? null,
      school_name: direct.name ?? direct.school_name ?? null,
    };
  }

  // 2) receipt -> SchoolOrder -> School
  const ord = orderAlias ? receipt[orderAlias] : receipt.school_order || receipt.SchoolOrder;
  const ordSchool = ord
    ? orderSchoolAlias
      ? ord[orderSchoolAlias]
      : ord.school || ord.School
    : null;

  if (ordSchool?.id || ordSchool?.name) {
    return {
      school_id: ordSchool.id ?? null,
      school_name: ordSchool.name ?? ordSchool.school_name ?? null,
    };
  }

  return { school_id: null, school_name: null };
}

/* =========================================
 * CREATE Supplier
 * → Auto-create Publisher with same details
 * Fastify handler: (request, reply)
 * ========================================= */
exports.create = async (request, reply) => {
  const t = await sequelize.transaction();
  try {
    const { name, contact_person, phone, email, address, is_active = true } = request.body || {};

    const cleanName = cleanStr(name);
    if (!cleanName) {
      await t.rollback();
      return reply.code(400).send({ error: "Supplier name is required." });
    }

    // 1️⃣ Create Supplier
    const supplier = await Supplier.create(
      {
        name: cleanName,
        contact_person: cleanNullable(contact_person),
        phone: cleanNullable(phone),
        email: cleanNullable(email),
        address: cleanNullable(address),
        is_active: toBool(is_active, true),
      },
      { transaction: t }
    );

    // 2️⃣ Auto-create Publisher (same details)
    await Publisher.create(
      {
        name: supplier.name,
        contact_person: supplier.contact_person,
        phone: supplier.phone,
        email: supplier.email,
        address: supplier.address,
        is_active: supplier.is_active,
      },
      { transaction: t }
    );

    await t.commit();

    return reply.code(201).send({
      message: "Supplier created successfully. Publisher auto-created.",
      supplier,
    });
  } catch (err) {
    await t.rollback();
    request.log?.error({ err }, "Create Supplier Error");

    if (err?.name === "SequelizeUniqueConstraintError") {
      return reply.code(409).send({ error: "Supplier with this name already exists." });
    }

    return reply.code(500).send({ error: "Failed to create supplier." });
  }
};

/* =========================================
 * READ – List all suppliers
 * ========================================= */
exports.list = async (request, reply) => {
  try {
    const suppliers = await Supplier.findAll({
      order: [["id", "DESC"]],
    });

    return reply.send(suppliers);
  } catch (err) {
    request.log?.error({ err }, "List Suppliers Error");
    return reply.code(500).send({ error: "Failed to fetch suppliers." });
  }
};

/* =========================================
 * READ – Get supplier by ID
 * ========================================= */
exports.getById = async (request, reply) => {
  try {
    const supplier = await Supplier.findByPk(request.params.id);

    if (!supplier) {
      return reply.code(404).send({ error: "Supplier not found." });
    }

    return reply.send(supplier);
  } catch (err) {
    request.log?.error({ err }, "Get Supplier Error");
    return reply.code(500).send({ error: "Failed to fetch supplier." });
  }
};

/* =========================================
 * UPDATE Supplier
 * (Does NOT touch Publisher)
 * ========================================= */
exports.update = async (request, reply) => {
  try {
    const supplier = await Supplier.findByPk(request.params.id);

    if (!supplier) {
      return reply.code(404).send({ error: "Supplier not found." });
    }

    const { name, contact_person, phone, email, address, is_active } = request.body || {};

    if (name !== undefined && !cleanStr(name)) {
      return reply.code(400).send({ error: "Supplier name cannot be empty." });
    }

    await supplier.update({
      name: name !== undefined ? cleanStr(name) : supplier.name,
      contact_person: contact_person !== undefined ? cleanNullable(contact_person) : supplier.contact_person,
      phone: phone !== undefined ? cleanNullable(phone) : supplier.phone,
      email: email !== undefined ? cleanNullable(email) : supplier.email,
      address: address !== undefined ? cleanNullable(address) : supplier.address,
      is_active: is_active !== undefined ? toBool(is_active, supplier.is_active) : supplier.is_active,
    });

    return reply.send({
      message: "Supplier updated successfully.",
      supplier,
    });
  } catch (err) {
    request.log?.error({ err }, "Update Supplier Error");

    if (err?.name === "SequelizeUniqueConstraintError") {
      return reply.code(409).send({ error: "Supplier with this name already exists." });
    }

    return reply.code(500).send({ error: "Failed to update supplier." });
  }
};

/* =========================================
 * DELETE Supplier (Soft delete)
 * Publisher is NOT deleted
 * ========================================= */
exports.remove = async (request, reply) => {
  try {
    const supplier = await Supplier.findByPk(request.params.id);

    if (!supplier) {
      return reply.code(404).send({ error: "Supplier not found." });
    }

    await supplier.update({ is_active: false });

    return reply.send({
      message: "Supplier deleted (soft delete).",
    });
  } catch (err) {
    request.log?.error({ err }, "Delete Supplier Error");
    return reply.code(500).send({ error: "Failed to delete supplier." });
  }
};

/* =========================================
 * ✅ Supplier Invoices List
 * GET /api/suppliers/:id/invoices
 * ✅ Now returns school_name also
 * ========================================= */
exports.listInvoices = async (request, reply) => {
  try {
    const supplierId = Number(request.params.id);
    if (!supplierId) {
      return reply.code(400).send({ error: "Invalid supplier id" });
    }

    const supplier = await Supplier.findByPk(supplierId, {
      attributes: ["id", "name"],
    });
    if (!supplier) {
      return reply.code(404).send({ error: "Supplier not found." });
    }

    // ✅ Fix alias issue automatically
    const itemsAlias = findAssocAlias(SupplierReceipt, SupplierReceiptItem);

    // ✅ School include support (direct OR via SchoolOrder)
    const schoolAlias = findAssocAlias(SupplierReceipt, School);
    const orderAlias = findAssocAlias(SupplierReceipt, SchoolOrder);
    const orderSchoolAlias = findAssocAlias(SchoolOrder, School);

    const includes = [];

    // items (count only)
    if (itemsAlias) {
      includes.push({
        model: SupplierReceiptItem,
        as: itemsAlias,
        attributes: ["id"],
        required: false,
      });
    }

    // direct receipt -> school
    const directSchoolInc = buildInclude(SupplierReceipt, School, {
      attributes: ["id", "name"],
      required: false,
    });
    if (directSchoolInc) includes.push(directSchoolInc);

    // receipt -> schoolOrder -> school
    const orderInc = buildInclude(SupplierReceipt, SchoolOrder, {
      attributes: ["id", "school_id"],
      required: false,
      include: [],
    });
    if (orderInc) {
      const nestedSchoolInc = buildInclude(SchoolOrder, School, {
        attributes: ["id", "name"],
        required: false,
      });
      if (nestedSchoolInc) orderInc.include.push(nestedSchoolInc);
      includes.push(orderInc);
    }

    const receipts = await SupplierReceipt.findAll({
      where: { supplier_id: supplierId },
      order: [["id", "DESC"]],
      include: includes,
    });

    const invoices = (receipts || []).map((r) => {
      const itemsArr = itemsAlias ? r[itemsAlias] : [];
      const { school_id, school_name } = extractSchoolMeta({
        receipt: r,
        schoolAlias,
        orderAlias,
        orderSchoolAlias,
      });

      return {
        id: r.id,
        receipt_no: r.receipt_no ?? r.invoice_no ?? null,
        status: r.status ?? null,
        received_date: r.received_date ?? null,
        doc_no: r.doc_no ?? r.bill_no ?? r.invoice_no ?? null,
        doc_date: r.doc_date ?? r.invoice_date ?? null,

        // ✅ NEW
        school_id,
        school_name,

        sub_total: r.sub_total ?? null,
        bill_discount_amount: r.bill_discount_amount ?? r.discount_amount ?? null,
        shipping_charge: r.shipping_charge ?? null,
        other_charge: r.other_charge ?? null,
        round_off: r.round_off ?? null,
        grand_total: r.grand_total ?? r.total ?? r.net_total ?? null,

        items_count: Array.isArray(itemsArr) ? itemsArr.length : 0,
      };
    });

    return reply.send({
      supplier: { id: supplier.id, name: supplier.name },
      invoices,
    });
  } catch (err) {
    request.log?.error({ err }, "listInvoices Error");
    return reply.code(500).send({ error: "Failed to fetch invoices." });
  }
};

/* =========================================
 * ✅ Supplier Invoice Detail
 * GET /api/suppliers/:id/invoices/:invoiceId
 * ✅ Now returns school_name also
 * ========================================= */
exports.getInvoiceDetail = async (request, reply) => {
  try {
    const supplierId = Number(request.params.id);
    const invoiceId = Number(request.params.invoiceId);

    if (!supplierId || !invoiceId) {
      return reply.code(400).send({ error: "Invalid supplier/invoice id" });
    }

    const itemsAlias = findAssocAlias(SupplierReceipt, SupplierReceiptItem);
    const bookAlias = findAssocAlias(SupplierReceiptItem, Book);

    // ✅ School include support (direct OR via SchoolOrder)
    const schoolAlias = findAssocAlias(SupplierReceipt, School);
    const orderAlias = findAssocAlias(SupplierReceipt, SchoolOrder);
    const orderSchoolAlias = findAssocAlias(SchoolOrder, School);

    const includes = [];

    // items + book
    if (itemsAlias) {
      includes.push({
        model: SupplierReceiptItem,
        as: itemsAlias,
        required: false,
        include: [
          bookAlias
            ? {
                model: Book,
                as: bookAlias,
                required: false,
                attributes: ["id", "title", "class_name", "subject", "code"],
              }
            : {
                model: Book,
                required: false,
                attributes: ["id", "title", "class_name", "subject", "code"],
              },
        ],
      });
    }

    // direct receipt -> school
    const directSchoolInc = buildInclude(SupplierReceipt, School, {
      attributes: ["id", "name"],
      required: false,
    });
    if (directSchoolInc) includes.push(directSchoolInc);

    // receipt -> schoolOrder -> school
    const orderInc = buildInclude(SupplierReceipt, SchoolOrder, {
      attributes: ["id", "school_id"],
      required: false,
      include: [],
    });
    if (orderInc) {
      const nestedSchoolInc = buildInclude(SchoolOrder, School, {
        attributes: ["id", "name"],
        required: false,
      });
      if (nestedSchoolInc) orderInc.include.push(nestedSchoolInc);
      includes.push(orderInc);
    }

    const receipt = await SupplierReceipt.findOne({
      where: { id: invoiceId, supplier_id: supplierId },
      include: includes,
    });

    if (!receipt) {
      return reply.code(404).send({ error: "Invoice not found." });
    }

    const rawItems = itemsAlias ? receipt[itemsAlias] : [];
    const items = (rawItems || []).map((it) => {
      const bk = bookAlias ? it[bookAlias] : it.Book;

      const qty = it.qty ?? it.quantity ?? it.received_qty ?? it.ordered_qty ?? null;
      const rate = it.rate ?? it.unit_price ?? it.price ?? null;

      const amount =
        it.amount ??
        it.line_total ??
        (qty != null && rate != null ? safeNumber(qty) * safeNumber(rate) : null);

      return {
        id: it.id,
        book_id: it.book_id ?? bk?.id ?? null,
        title: bk?.title ?? it.title ?? null,
        class_name: bk?.class_name ?? it.class_name ?? null,
        subject: bk?.subject ?? it.subject ?? null,
        code: bk?.code ?? it.code ?? null,
        qty,
        rate,
        amount,
      };
    });

    const { school_id, school_name } = extractSchoolMeta({
      receipt,
      schoolAlias,
      orderAlias,
      orderSchoolAlias,
    });

    return reply.send({
      supplier: { id: supplierId },
      school: school_name ? { id: school_id, name: school_name } : null, // ✅ NEW (easy for frontend)
      invoice: {
        id: receipt.id,
        receipt_no: receipt.receipt_no ?? receipt.invoice_no ?? null,
        status: receipt.status ?? null,
        received_date: receipt.received_date ?? null,
        doc_no: receipt.doc_no ?? receipt.bill_no ?? receipt.invoice_no ?? null,
        doc_date: receipt.doc_date ?? receipt.invoice_date ?? null,

        // ✅ NEW
        school_id,
        school_name,

        sub_total: receipt.sub_total ?? null,
        bill_discount_amount: receipt.bill_discount_amount ?? receipt.discount_amount ?? null,
        shipping_charge: receipt.shipping_charge ?? null,
        other_charge: receipt.other_charge ?? null,
        round_off: receipt.round_off ?? null,
        grand_total: receipt.grand_total ?? receipt.total ?? receipt.net_total ?? null,

        items_count: items.length,
      },
      items,
    });
  } catch (err) {
    request.log?.error({ err }, "getInvoiceDetail Error");
    return reply.code(500).send({ error: "Failed to fetch invoice detail." });
  }
};
