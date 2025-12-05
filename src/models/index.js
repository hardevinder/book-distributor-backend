// src/models/index.js
const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

// Models
const User = require("./user")(sequelize, DataTypes);
const Publisher = require("./publisher")(sequelize, DataTypes);
const Book = require("./book")(sequelize, DataTypes);
const Class = require("./class")(sequelize, DataTypes);
const School = require("./school")(sequelize, DataTypes);

// ⭐ SchoolBookRequirement model
const SchoolBookRequirement = require("./schoolBookRequirement")(
  sequelize,
  DataTypes
);

// ⭐ NEW: Publisher Orders models
const PublisherOrder = require("./publisherOrder")(sequelize, DataTypes);
const PublisherOrderItem = require("./publisherOrderItem")(sequelize, DataTypes);
const RequirementOrderLink = require("./requirementOrderLink")(
  sequelize,
  DataTypes
);

/* ======================
        ASSOCIATIONS
   ====================== */

// 📌 Publisher → Books (1:N)
Publisher.hasMany(Book, {
  foreignKey: "publisher_id",
  as: "books",
});

Book.belongsTo(Publisher, {
  foreignKey: "publisher_id",
  as: "publisher",
});

/**
 * OPTIONAL (future):
 * If you later add `class_id` to Books table
 *
 * Class.hasMany(Book, { foreignKey: "class_id", as: "books" });
 * Book.belongsTo(Class, { foreignKey: "class_id", as: "class" });
 */

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

// 📌 Class → SchoolBookRequirement (1:N, optional)
Class.hasMany(SchoolBookRequirement, {
  foreignKey: "class_id",
  as: "requirements",
});

SchoolBookRequirement.belongsTo(Class, {
  foreignKey: "class_id",
  as: "class",
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

// 📌 Book → PublisherOrderItem (1:N)  (each item is for a specific book)
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

// 📌 (Future) If School will have Orders / Students, link here.

module.exports = {
  sequelize,
  User,
  Publisher,
  Book,
  Class,
  School,
  SchoolBookRequirement,
  PublisherOrder,
  PublisherOrderItem,
  RequirementOrderLink,
};
