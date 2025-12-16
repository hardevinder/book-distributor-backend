// src/models/index.js

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
const SchoolRequirementOrderLink = require("./schoolRequirementOrderLink")(sequelize, DataTypes);

/* ======================
        ASSOCIATIONS
   ====================== */

/* ------------------------------------------------
   ✅ Supplier is INDEPENDENT (NO relation to Publisher)
   ------------------------------------------------ */

/* -------------------------
   Publisher ↔ Books (1:N)
   ------------------------- */

Publisher.hasMany(Book, {
  foreignKey: "publisher_id",
  as: "books",
});

Book.belongsTo(Publisher, {
  foreignKey: "publisher_id",
  as: "publisher",
});

/* ============================
   School ↔ Book Requirements
   ============================ */

// 📌 School → SchoolBookRequirement (1:N)
School.hasMany(SchoolBookRequirement, {
  foreignKey: "school_id",
  as: "requirements",
});

SchoolBookRequirement.belongsTo(School, {
  foreignKey: "school_id",
  as: "school",
});

// 📌 Book → SchoolBookRequirement (1:N)
Book.hasMany(SchoolBookRequirement, {
  foreignKey: "book_id",
  as: "requirements",
});

SchoolBookRequirement.belongsTo(Book, {
  foreignKey: "book_id",
  as: "book",
});

// 📌 Class → SchoolBookRequirement (1:N)
Class.hasMany(SchoolBookRequirement, {
  foreignKey: "class_id",
  as: "requirements",
});

SchoolBookRequirement.belongsTo(Class, {
  foreignKey: "class_id",
  as: "class",
});

/* ---------------------------------------
   ✅ Supplier ↔ SchoolBookRequirement (1:N)
   --------------------------------------- */

Supplier.hasMany(SchoolBookRequirement, {
  foreignKey: "supplier_id",
  as: "requirements",
});

SchoolBookRequirement.belongsTo(Supplier, {
  foreignKey: "supplier_id",
  as: "supplier",
});

/* ============================
   Publisher Orders Relations
   ============================ */

// 📌 Publisher → PublisherOrder (1:N)
Publisher.hasMany(PublisherOrder, {
  foreignKey: "publisher_id",
  as: "orders",
});

PublisherOrder.belongsTo(Publisher, {
  foreignKey: "publisher_id",
  as: "publisher",
});

// 📌 PublisherOrder → PublisherOrderItem (1:N)
PublisherOrder.hasMany(PublisherOrderItem, {
  foreignKey: "publisher_order_id",
  as: "items",
});

PublisherOrderItem.belongsTo(PublisherOrder, {
  foreignKey: "publisher_order_id",
  as: "order",
});

// 📌 Book → PublisherOrderItem (1:N)
Book.hasMany(PublisherOrderItem, {
  foreignKey: "book_id",
  as: "publisher_order_items",
});

PublisherOrderItem.belongsTo(Book, {
  foreignKey: "book_id",
  as: "book",
});

/* =========================================
   Requirement ↔ PublisherOrderItem Mapping
   ========================================= */

// 📌 SchoolBookRequirement → RequirementOrderLink (1:N)
SchoolBookRequirement.hasMany(RequirementOrderLink, {
  foreignKey: "requirement_id",
  as: "order_links",
});

RequirementOrderLink.belongsTo(SchoolBookRequirement, {
  foreignKey: "requirement_id",
  as: "requirement",
});

// 📌 PublisherOrderItem → RequirementOrderLink (1:N)
PublisherOrderItem.hasMany(RequirementOrderLink, {
  foreignKey: "publisher_order_item_id",
  as: "requirement_links",
});

RequirementOrderLink.belongsTo(PublisherOrderItem, {
  foreignKey: "publisher_order_item_id",
  as: "order_item",
});

/* ============================
   School Orders Relations
   ============================ */

// 📌 School → SchoolOrder (1:N)
School.hasMany(SchoolOrder, {
  foreignKey: "school_id",
  as: "school_orders",
});

SchoolOrder.belongsTo(School, {
  foreignKey: "school_id",
  as: "school",
});

/* ---------------------------------------------------
   ✅ FIX: Supplier ↔ SchoolOrder (1:N)  (MISSING EARLIER)
   --------------------------------------------------- */

Supplier.hasMany(SchoolOrder, {
  foreignKey: "supplier_id",
  as: "schoolOrders",
});

SchoolOrder.belongsTo(Supplier, {
  foreignKey: "supplier_id",
  as: "supplier",
});

// 📌 SchoolOrder → SchoolOrderItem (1:N)
SchoolOrder.hasMany(SchoolOrderItem, {
  foreignKey: "school_order_id",
  as: "items",
});

SchoolOrderItem.belongsTo(SchoolOrder, {
  foreignKey: "school_order_id",
  as: "order",
});

// 📌 Book → SchoolOrderItem (1:N)
Book.hasMany(SchoolOrderItem, {
  foreignKey: "book_id",
  as: "school_order_items",
});

SchoolOrderItem.belongsTo(Book, {
  foreignKey: "book_id",
  as: "book",
});

/* =========================================
   Requirement ↔ SchoolOrderItem Mapping
   ========================================= */

// 📌 SchoolBookRequirement → SchoolRequirementOrderLink (1:N)
SchoolBookRequirement.hasMany(SchoolRequirementOrderLink, {
  foreignKey: "requirement_id",
  as: "school_order_links",
});

SchoolRequirementOrderLink.belongsTo(SchoolBookRequirement, {
  foreignKey: "requirement_id",
  as: "requirement",
});

// 📌 SchoolOrderItem → SchoolRequirementOrderLink (1:N)
SchoolOrderItem.hasMany(SchoolRequirementOrderLink, {
  foreignKey: "school_order_item_id",
  as: "requirement_links",
});

SchoolRequirementOrderLink.belongsTo(SchoolOrderItem, {
  foreignKey: "school_order_item_id",
  as: "school_order_item",
});

/* ============================
   Transport Relations
   ============================ */

Transport.hasMany(SchoolOrder, {
  foreignKey: "transport_id",
  as: "school_orders",
});

SchoolOrder.belongsTo(Transport, {
  foreignKey: "transport_id",
  as: "transport",
});

// ✅ Option 2 transport relation (use different alias)
Transport.hasMany(SchoolOrder, {
  foreignKey: "transport_id_2",
  as: "school_orders_2",
});

SchoolOrder.belongsTo(Transport, {
  foreignKey: "transport_id_2",
  as: "transport2",
});

// No associations required for CompanyProfile yet (stand-alone master)

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
};
