// src/models/schoolBookRequirement.js
"use strict";

module.exports = (sequelize, DataTypes) => {
  const SchoolBookRequirement = sequelize.define(
    "SchoolBookRequirement",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      // 🔗 Which school is giving this requirement
      school_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      // 🔗 Which book (publisher comes via Book → Publisher relation)
      book_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      // Optional: link to Class table (for reports / filters)
      class_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      // For which academic year, e.g. "2025-26"
      academic_session: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },

      // 📦 Number of copies required
      required_copies: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },

      // Status: draft while Excel is being filled, confirmed when final
      status: {
        type: DataTypes.ENUM("draft", "confirmed"),
        allowNull: false,
        defaultValue: "draft",
      },

      // Any note from school (optional)
      remarks: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },

      // Lock after finalisation so school can’t change without your approval
      is_locked: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },

      // ✅ Exists in DB
      supplier_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },
    },
    {
      tableName: "school_book_requirements",
      timestamps: true,
      indexes: [
        {
          name: "uniq_school_book_session",
          unique: true,
          fields: ["school_id", "book_id", "academic_session"],
        },
        { fields: ["school_id"] },
        { fields: ["book_id"] },
        { fields: ["class_id"] },
        { fields: ["academic_session"] },
        { fields: ["supplier_id"] }, // ✅ helpful filter/index
      ],
    }
  );

  // 🧩 Associations (IMPORTANT: keep ALL associations inside this function)
  SchoolBookRequirement.associate = (models) => {
    // 🔗 School
    if (models.School) {
      SchoolBookRequirement.belongsTo(models.School, {
        foreignKey: "school_id",
        as: "school",
      });
    }

    // 🔗 Book
    if (models.Book) {
      SchoolBookRequirement.belongsTo(models.Book, {
        foreignKey: "book_id",
        as: "book",
      });
    }

    // 🔗 Class (optional)
    if (models.Class) {
      SchoolBookRequirement.belongsTo(models.Class, {
        foreignKey: "class_id",
        as: "class",
      });
    }

    // ✅ Supplier (optional)
    if (models.Supplier) {
      SchoolBookRequirement.belongsTo(models.Supplier, {
        foreignKey: "supplier_id",
        as: "supplier",
      });
    }

    // 🔗 Links to publisher order items (allocation)
    if (models.RequirementOrderLink) {
      SchoolBookRequirement.hasMany(models.RequirementOrderLink, {
        foreignKey: "requirement_id",
        as: "order_links",
      });
    }

    // ✅ If you later want reverse relation from requirement to school sale items
    if (models.SchoolSaleItem) {
      SchoolBookRequirement.hasMany(models.SchoolSaleItem, {
        foreignKey: "requirement_item_id",
        as: "sale_items",
      });
    }
  };

  return SchoolBookRequirement;
};