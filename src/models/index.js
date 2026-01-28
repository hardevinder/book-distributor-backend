"use strict";

const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

/* ======================
   BASE MODELS
   ====================== */
const User = require("./user")(sequelize, DataTypes);

// Masters
const Supplier = require("./supplier")(sequelize, DataTypes);
const Publisher = require("./publisher")(sequelize, DataTypes);
const Book = require("./book")(sequelize, DataTypes);
const Class = require("./class")(sequelize, DataTypes);
const School = require("./school")(sequelize, DataTypes);
const Transport = require("./transport")(sequelize, DataTypes);
const CompanyProfile = require("./companyProfile")(sequelize, DataTypes);

// ✅ Products (POS / Bundles)
const Product = require("./product")(sequelize, DataTypes);

/* ======================
   REQUIREMENTS
   ====================== */
const SchoolBookRequirement = require("./schoolBookRequirement")(sequelize, DataTypes);

/* ======================
   PUBLISHER ORDERS
   ====================== */
const PublisherOrder = require("./publisherOrder")(sequelize, DataTypes);
const PublisherOrderItem = require("./publisherOrderItem")(sequelize, DataTypes);
const RequirementOrderLink = require("./requirementOrderLink")(sequelize, DataTypes);

/* ======================
   SCHOOL ORDERS
   ====================== */
const SchoolOrder = require("./schoolOrder")(sequelize, DataTypes);
const SchoolOrderItem = require("./schoolOrderItem")(sequelize, DataTypes);
const SchoolRequirementOrderLink = require("./schoolRequirementOrderLink")(sequelize, DataTypes);

/* ======================
   EMAIL LOGS
   ====================== */
const SchoolOrderEmailLog = require("./schoolOrderEmailLog")(sequelize, DataTypes);

/* ======================
   INVENTORY
   ====================== */
const InventoryBatch = require("./inventoryBatch")(sequelize, DataTypes);
const InventoryTxn = require("./inventoryTxn")(sequelize, DataTypes);

/* ======================
   BUNDLES / DISPATCH
   ====================== */
const Bundle = require("./bundle")(sequelize, DataTypes);
const BundleItem = require("./bundleItem")(sequelize, DataTypes);
const Distributor = require("./distributor")(sequelize, DataTypes);
const BundleIssue = require("./bundleIssue")(sequelize, DataTypes);
const BundleDispatch = require("./bundleDispatch")(sequelize, DataTypes);

/* ======================
   SUPPLIER ACCOUNTING
   ====================== */
const SupplierReceipt = require("./supplierReceipt")(sequelize, DataTypes);
const SupplierReceiptItem = require("./supplierReceiptItem")(sequelize, DataTypes);
const SupplierReceiptAllocation = require("./supplierReceiptAllocation")(sequelize, DataTypes);
const SupplierPayment = require("./supplierPayment")(sequelize, DataTypes);
const SupplierLedgerTxn = require("./supplierLedgerTxn")(sequelize, DataTypes);

/* =====================================================
   ASSOCIATIONS (manual + safe)
   NOTE:
   Do NOT call model.associate(db) here because many models
   already define associations internally and it causes
   duplicate alias errors (like "receipts").
   ===================================================== */

/* ---------- Publisher ↔ Books ---------- */
Publisher.hasMany(Book, { foreignKey: "publisher_id", as: "books" });
Book.belongsTo(Publisher, { foreignKey: "publisher_id", as: "publisher" });

/* ---------- Supplier ↔ Books ---------- */
Supplier.hasMany(Book, { foreignKey: "supplier_id", as: "books" });
Book.belongsTo(Supplier, { foreignKey: "supplier_id", as: "supplier" });

/* ---------- ✅ Product ↔ Book ---------- */
Book.hasMany(Product, { foreignKey: "book_id", as: "products" });
Product.belongsTo(Book, { foreignKey: "book_id", as: "book" });

/* ---------- School ↔ Book Requirements ---------- */
School.hasMany(SchoolBookRequirement, { foreignKey: "school_id", as: "requirements" });
SchoolBookRequirement.belongsTo(School, { foreignKey: "school_id", as: "school" });

Book.hasMany(SchoolBookRequirement, { foreignKey: "book_id", as: "requirements" });
SchoolBookRequirement.belongsTo(Book, { foreignKey: "book_id", as: "book" });

Class.hasMany(SchoolBookRequirement, { foreignKey: "class_id", as: "requirements" });
SchoolBookRequirement.belongsTo(Class, { foreignKey: "class_id", as: "class" });

Supplier.hasMany(SchoolBookRequirement, { foreignKey: "supplier_id", as: "requirements" });
SchoolBookRequirement.belongsTo(Supplier, { foreignKey: "supplier_id", as: "supplier" });

/* ---------- Publisher Orders ---------- */
Publisher.hasMany(PublisherOrder, { foreignKey: "publisher_id", as: "orders" });
PublisherOrder.belongsTo(Publisher, { foreignKey: "publisher_id", as: "publisher" });

PublisherOrder.hasMany(PublisherOrderItem, { foreignKey: "publisher_order_id", as: "items" });
PublisherOrderItem.belongsTo(PublisherOrder, { foreignKey: "publisher_order_id", as: "order" });

Book.hasMany(PublisherOrderItem, { foreignKey: "book_id", as: "publisher_order_items" });
PublisherOrderItem.belongsTo(Book, { foreignKey: "book_id", as: "book" });

/* ---------- School Orders ---------- */
School.hasMany(SchoolOrder, { foreignKey: "school_id", as: "school_orders" });
SchoolOrder.belongsTo(School, { foreignKey: "school_id", as: "school" });

Supplier.hasMany(SchoolOrder, { foreignKey: "supplier_id", as: "schoolOrders" });
SchoolOrder.belongsTo(Supplier, { foreignKey: "supplier_id", as: "supplier" });

SchoolOrder.hasMany(SchoolOrderItem, { foreignKey: "school_order_id", as: "items" });
SchoolOrderItem.belongsTo(SchoolOrder, { foreignKey: "school_order_id", as: "order" });

Book.hasMany(SchoolOrderItem, { foreignKey: "book_id", as: "school_order_items" });
SchoolOrderItem.belongsTo(Book, { foreignKey: "book_id", as: "book" });

/* ---------- School Orders ↔ Email Logs ---------- */
SchoolOrder.hasMany(SchoolOrderEmailLog, { foreignKey: "school_order_id", as: "emailLogs" });
SchoolOrderEmailLog.belongsTo(SchoolOrder, { foreignKey: "school_order_id", as: "order" });

/* ---------- Transport ---------- */
Transport.hasMany(SchoolOrder, { foreignKey: "transport_id", as: "schoolOrders_transport1" });
SchoolOrder.belongsTo(Transport, { foreignKey: "transport_id", as: "transport" });

Transport.hasMany(SchoolOrder, { foreignKey: "transport_id_2", as: "schoolOrders_transport2" });
SchoolOrder.belongsTo(Transport, { foreignKey: "transport_id_2", as: "transport2" });

/* ---------- Inventory ---------- */
Book.hasMany(InventoryBatch, { foreignKey: "book_id", as: "inventory_batches" });
InventoryBatch.belongsTo(Book, { foreignKey: "book_id", as: "book" });

Supplier.hasMany(InventoryBatch, { foreignKey: "supplier_id", as: "inventory_batches" });
InventoryBatch.belongsTo(Supplier, { foreignKey: "supplier_id", as: "supplier" });

/* ✅ FIX: SchoolOrder ↔ InventoryBatch (this removes your error) */
SchoolOrder.hasMany(InventoryBatch, { foreignKey: "school_order_id", as: "inventoryBatches" });
InventoryBatch.belongsTo(SchoolOrder, { foreignKey: "school_order_id", as: "schoolOrder" });

InventoryBatch.hasMany(InventoryTxn, { foreignKey: "batch_id", as: "txns" });
InventoryTxn.belongsTo(InventoryBatch, { foreignKey: "batch_id", as: "batch" });

/* ---------- Bundles ---------- */
Bundle.hasMany(BundleItem, { foreignKey: "bundle_id", as: "items" });
BundleItem.belongsTo(Bundle, { foreignKey: "bundle_id", as: "bundle" });

/* ✅ BundleItem ↔ Product */
Product.hasMany(BundleItem, { foreignKey: "product_id", as: "bundle_items" });
BundleItem.belongsTo(Product, { foreignKey: "product_id", as: "product" });

/* ✅ Bundle ↔ School / Class */
School.hasMany(Bundle, { foreignKey: "school_id", as: "bundles" });
Bundle.belongsTo(School, { foreignKey: "school_id", as: "school" });

Class.hasMany(Bundle, { foreignKey: "class_id", as: "bundles" });
Bundle.belongsTo(Class, { foreignKey: "class_id", as: "class" });

Bundle.hasMany(BundleIssue, { foreignKey: "bundle_id", as: "issues" });
BundleIssue.belongsTo(Bundle, { foreignKey: "bundle_id", as: "bundle" });

BundleIssue.hasMany(BundleDispatch, { foreignKey: "bundle_issue_id", as: "dispatches" });
BundleDispatch.belongsTo(BundleIssue, { foreignKey: "bundle_issue_id", as: "issue" });

if (BundleDispatch.rawAttributes && BundleDispatch.rawAttributes.distributor_id) {
  Distributor.hasMany(BundleDispatch, { foreignKey: "distributor_id", as: "bundleDispatches" });
  BundleDispatch.belongsTo(Distributor, { foreignKey: "distributor_id", as: "distributor" });
}

/* ---------- Supplier Receipts ---------- */
Supplier.hasMany(SupplierReceipt, { foreignKey: "supplier_id", as: "receipts" });
SupplierReceipt.belongsTo(Supplier, { foreignKey: "supplier_id", as: "supplier" });

SchoolOrder.hasMany(SupplierReceipt, { foreignKey: "school_order_id", as: "supplierReceipts" });
SupplierReceipt.belongsTo(SchoolOrder, { foreignKey: "school_order_id", as: "schoolOrder" });

SupplierReceipt.hasMany(SupplierReceiptItem, {
  foreignKey: "supplier_receipt_id",
  as: "items",
  onDelete: "CASCADE",
  hooks: true,
});
SupplierReceiptItem.belongsTo(SupplierReceipt, { foreignKey: "supplier_receipt_id", as: "receipt" });

Book.hasMany(SupplierReceiptItem, { foreignKey: "book_id", as: "supplier_receipt_items" });
SupplierReceiptItem.belongsTo(Book, { foreignKey: "book_id", as: "book" });

/* ---------- Supplier Receipt Allocations ---------- */
SupplierReceipt.hasMany(SupplierReceiptAllocation, {
  foreignKey: "supplier_receipt_id",
  as: "allocations",
  onDelete: "CASCADE",
  hooks: true,
});
SupplierReceiptAllocation.belongsTo(SupplierReceipt, {
  foreignKey: "supplier_receipt_id",
  as: "receipt",
});

School.hasMany(SupplierReceiptAllocation, { foreignKey: "school_id", as: "supplierReceiptAllocations" });
SupplierReceiptAllocation.belongsTo(School, { foreignKey: "school_id", as: "school" });

Book.hasMany(SupplierReceiptAllocation, { foreignKey: "book_id", as: "supplierReceiptAllocations" });
SupplierReceiptAllocation.belongsTo(Book, { foreignKey: "book_id", as: "book" });

/* ---------- Supplier Payments ---------- */
Supplier.hasMany(SupplierPayment, { foreignKey: "supplier_id", as: "payments" });
SupplierPayment.belongsTo(Supplier, { foreignKey: "supplier_id", as: "supplier" });

/* ---------- Supplier Ledger ---------- */
Supplier.hasMany(SupplierLedgerTxn, { foreignKey: "supplier_id", as: "ledgerTxns" });
SupplierLedgerTxn.belongsTo(Supplier, { foreignKey: "supplier_id", as: "supplier" });

SupplierReceipt.hasMany(SupplierLedgerTxn, {
  foreignKey: "ref_id",
  sourceKey: "id",
  as: "ledgerTxns",
  constraints: false,
  scope: { ref_table: "supplier_receipts" },
});

SupplierPayment.hasMany(SupplierLedgerTxn, {
  foreignKey: "ref_id",
  sourceKey: "id",
  as: "ledgerTxns",
  constraints: false,
  scope: { ref_table: "supplier_payments" },
});

/* =====================================================
   EXPORTS
   ===================================================== */
const db = {
  sequelize,

  User,
  Supplier,
  Publisher,
  Book,
  Class,
  School,
  Transport,
  CompanyProfile,

  Product,

  SchoolBookRequirement,

  PublisherOrder,
  PublisherOrderItem,
  RequirementOrderLink,

  SchoolOrder,
  SchoolOrderItem,
  SchoolRequirementOrderLink,

  SchoolOrderEmailLog,

  InventoryBatch,
  InventoryTxn,

  Bundle,
  BundleItem,
  Distributor,
  BundleIssue,
  BundleDispatch,

  SupplierReceipt,
  SupplierReceiptItem,
  SupplierReceiptAllocation,
  SupplierPayment,
  SupplierLedgerTxn,
};

module.exports = db;
