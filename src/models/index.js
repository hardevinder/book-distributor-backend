"use strict";

const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

// Base Models
const User = require("./user")(sequelize, DataTypes);

// Supplier master (independent)
const Supplier = require("./supplier")(sequelize, DataTypes);

const Publisher = require("./publisher")(sequelize, DataTypes);
const Book = require("./book")(sequelize, DataTypes);
const Class = require("./class")(sequelize, DataTypes);
const School = require("./school")(sequelize, DataTypes);

// Transport master
const Transport = require("./transport")(sequelize, DataTypes);

// Company Profile master
const CompanyProfile = require("./companyProfile")(sequelize, DataTypes);

// SchoolBookRequirement model
const SchoolBookRequirement = require("./schoolBookRequirement")(sequelize, DataTypes);

// Publisher Orders models
const PublisherOrder = require("./publisherOrder")(sequelize, DataTypes);
const PublisherOrderItem = require("./publisherOrderItem")(sequelize, DataTypes);
const RequirementOrderLink = require("./requirementOrderLink")(sequelize, DataTypes);

// School Orders models
const SchoolOrder = require("./schoolOrder")(sequelize, DataTypes);
const SchoolOrderItem = require("./schoolOrderItem")(sequelize, DataTypes);
const SchoolRequirementOrderLink =
  require("./schoolRequirementOrderLink")(sequelize, DataTypes);

// ✅ Module-2 Inventory models
const InventoryBatch = require("./inventoryBatch")(sequelize, DataTypes);
const InventoryTxn = require("./inventoryTxn")(sequelize, DataTypes);

// ✅ Step-2 Bundles/Kits models
const Bundle = require("./bundle")(sequelize, DataTypes);
const BundleItem = require("./bundleItem")(sequelize, DataTypes);

// ✅ Distributor / Issue / Dispatch
const Distributor = require("./distributor")(sequelize, DataTypes);
const BundleIssue = require("./bundleIssue")(sequelize, DataTypes);
const BundleDispatch = require("./bundleDispatch")(sequelize, DataTypes);

// ✅ NEW (Supplier-focused): Receiving & Ledger
const SupplierReceipt = require("./supplierReceipt")(sequelize, DataTypes);
const SupplierReceiptItem = require("./supplierReceiptItem")(sequelize, DataTypes);
const SupplierLedgerTxn = require("./supplierLedgerTxn")(sequelize, DataTypes);

/* ======================
        ASSOCIATIONS
   ====================== */

/* -------------------------
   Publisher ↔ Books
   ------------------------- */
Publisher.hasMany(Book, { foreignKey: "publisher_id", as: "books" });
Book.belongsTo(Publisher, { foreignKey: "publisher_id", as: "publisher" });

/* -------------------------
   Supplier ↔ Books
   ------------------------- */
Supplier.hasMany(Book, { foreignKey: "supplier_id", as: "books" });
Book.belongsTo(Supplier, { foreignKey: "supplier_id", as: "supplier" });

/* ============================
   School ↔ Book Requirements
   ============================ */
School.hasMany(SchoolBookRequirement, {
  foreignKey: "school_id",
  as: "requirements",
});
SchoolBookRequirement.belongsTo(School, {
  foreignKey: "school_id",
  as: "school",
});

Book.hasMany(SchoolBookRequirement, {
  foreignKey: "book_id",
  as: "requirements",
});
SchoolBookRequirement.belongsTo(Book, {
  foreignKey: "book_id",
  as: "book",
});

Class.hasMany(SchoolBookRequirement, {
  foreignKey: "class_id",
  as: "requirements",
});
SchoolBookRequirement.belongsTo(Class, {
  foreignKey: "class_id",
  as: "class",
});

Supplier.hasMany(SchoolBookRequirement, {
  foreignKey: "supplier_id",
  as: "requirements",
});
SchoolBookRequirement.belongsTo(Supplier, {
  foreignKey: "supplier_id",
  as: "supplier",
});

/* ============================
   Publisher Orders
   ============================ */
Publisher.hasMany(PublisherOrder, {
  foreignKey: "publisher_id",
  as: "orders",
});
PublisherOrder.belongsTo(Publisher, {
  foreignKey: "publisher_id",
  as: "publisher",
});

PublisherOrder.hasMany(PublisherOrderItem, {
  foreignKey: "publisher_order_id",
  as: "items",
});
PublisherOrderItem.belongsTo(PublisherOrder, {
  foreignKey: "publisher_order_id",
  as: "order",
});

Book.hasMany(PublisherOrderItem, {
  foreignKey: "book_id",
  as: "publisher_order_items",
});
PublisherOrderItem.belongsTo(Book, {
  foreignKey: "book_id",
  as: "book",
});

/* ============================
   School Orders
   ============================ */
School.hasMany(SchoolOrder, {
  foreignKey: "school_id",
  as: "school_orders",
});
SchoolOrder.belongsTo(School, {
  foreignKey: "school_id",
  as: "school",
});

Supplier.hasMany(SchoolOrder, {
  foreignKey: "supplier_id",
  as: "schoolOrders",
});
SchoolOrder.belongsTo(Supplier, {
  foreignKey: "supplier_id",
  as: "supplier",
});

SchoolOrder.hasMany(SchoolOrderItem, {
  foreignKey: "school_order_id",
  as: "items",
});
SchoolOrderItem.belongsTo(SchoolOrder, {
  foreignKey: "school_order_id",
  as: "order",
});

Book.hasMany(SchoolOrderItem, {
  foreignKey: "book_id",
  as: "school_order_items",
});
SchoolOrderItem.belongsTo(Book, {
  foreignKey: "book_id",
  as: "book",
});

/* ============================
   ✅ School Orders ↔ Transport
   ============================ */

// Option 1
Transport.hasMany(SchoolOrder, {
  foreignKey: "transport_id",
  as: "schoolOrders_transport1",
});
SchoolOrder.belongsTo(Transport, {
  foreignKey: "transport_id",
  as: "transport",
});

// Option 2
Transport.hasMany(SchoolOrder, {
  foreignKey: "transport_id_2",
  as: "schoolOrders_transport2",
});
SchoolOrder.belongsTo(Transport, {
  foreignKey: "transport_id_2",
  as: "transport2",
});

/* ============================
   Inventory Relations
   ============================ */
Book.hasMany(InventoryBatch, {
  foreignKey: "book_id",
  as: "inventory_batches",
});
InventoryBatch.belongsTo(Book, {
  foreignKey: "book_id",
  as: "book",
});

Supplier.hasMany(InventoryBatch, {
  foreignKey: "supplier_id",
  as: "inventory_batches",
});
InventoryBatch.belongsTo(Supplier, {
  foreignKey: "supplier_id",
  as: "supplier",
});

InventoryBatch.hasMany(InventoryTxn, {
  foreignKey: "batch_id",
  as: "txns",
});
InventoryTxn.belongsTo(InventoryBatch, {
  foreignKey: "batch_id",
  as: "batch",
});

/* ============================
   Bundles / Dispatch
   ============================ */
Bundle.hasMany(BundleItem, { foreignKey: "bundle_id", as: "items" });
BundleItem.belongsTo(Bundle, { foreignKey: "bundle_id", as: "bundle" });

Bundle.hasMany(BundleIssue, { foreignKey: "bundle_id", as: "issues" });
BundleIssue.belongsTo(Bundle, { foreignKey: "bundle_id", as: "bundle" });

BundleIssue.hasMany(BundleDispatch, {
  foreignKey: "bundle_issue_id",
  as: "dispatches",
});
BundleDispatch.belongsTo(BundleIssue, {
  foreignKey: "bundle_issue_id",
  as: "issue",
});

/* ============================
   ✅ NEW: Supplier Receipts
   ============================ */
Supplier.hasMany(SupplierReceipt, {
  foreignKey: "supplier_id",
  as: "receipts",
});
SupplierReceipt.belongsTo(Supplier, {
  foreignKey: "supplier_id",
  as: "supplier",
});

// ✅ optional: Receipt -> SchoolOrder (recommended)
SchoolOrder.hasMany(SupplierReceipt, {
  foreignKey: "school_order_id",
  as: "supplierReceipts",
});
SupplierReceipt.belongsTo(SchoolOrder, {
  foreignKey: "school_order_id",
  as: "schoolOrder",
});

// Receipt -> Items
SupplierReceipt.hasMany(SupplierReceiptItem, {
  foreignKey: "supplier_receipt_id",
  as: "items",
  onDelete: "CASCADE",
  hooks: true,
});
SupplierReceiptItem.belongsTo(SupplierReceipt, {
  foreignKey: "supplier_receipt_id",
  as: "receipt",
});

// Item -> Book
Book.hasMany(SupplierReceiptItem, {
  foreignKey: "book_id",
  as: "supplier_receipt_items",
});
SupplierReceiptItem.belongsTo(Book, {
  foreignKey: "book_id",
  as: "book",
});

/* ============================
   ✅ NEW: Supplier Ledger
   ============================ */
Supplier.hasMany(SupplierLedgerTxn, {
  foreignKey: "supplier_id",
  as: "ledgerTxns",
});
SupplierLedgerTxn.belongsTo(Supplier, {
  foreignKey: "supplier_id",
  as: "supplier",
});

// ✅ optional: Receipt -> Ledger txns convenience (polymorphic)
SupplierReceipt.hasMany(SupplierLedgerTxn, {
  foreignKey: "ref_id",
  sourceKey: "id",
  as: "ledgerTxns",
  constraints: false,
  scope: { ref_table: "supplier_receipts" },
});

/* ============================
         EXPORT MODELS
   ============================ */
module.exports = {
  sequelize,

  User,
  Supplier,
  Publisher,
  Book,
  Class,
  School,
  Transport,
  CompanyProfile,
  SchoolBookRequirement,

  PublisherOrder,
  PublisherOrderItem,
  RequirementOrderLink,

  SchoolOrder,
  SchoolOrderItem,
  SchoolRequirementOrderLink,

  InventoryBatch,
  InventoryTxn,

  Bundle,
  BundleItem,

  Distributor,
  BundleIssue,
  BundleDispatch,

  // ✅ NEW (Supplier-focused)
  SupplierReceipt,
  SupplierReceiptItem,
  SupplierLedgerTxn,
};
