"use strict";

module.exports = (sequelize, DataTypes) => {
  const BundleItem = sequelize.define(
    "BundleItem",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      bundle_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      product_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      // ✅ TOTAL qty (school-wise / issued qty / computed qty)
      qty: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 1,
      },

      // ✅ NEW: per-student qty (template qty)
      per_student_qty: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 1,
      },

      mrp: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },

      sale_price: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },

      is_optional: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },

      sort_order: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      tableName: "bundle_items",
      timestamps: true,
      indexes: [
        { name: "idx_bundle_items_bundle", fields: ["bundle_id"] },
        { name: "idx_bundle_items_product", fields: ["product_id"] },
        { name: "uniq_bundle_items_bundle_product", unique: true, fields: ["bundle_id", "product_id"] },

        // ✅ Helpful when calculating totals based on per-student qty
        { name: "idx_bundle_items_bundle_per_student", fields: ["bundle_id", "per_student_qty"] },
      ],
      hooks: {
        beforeValidate: (row) => {
          // normalize numbers safely
          const toUInt = (v, d = 0) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return d;
            return n < 0 ? 0 : Math.floor(n);
          };

          row.qty = toUInt(row.qty, 1);
          row.per_student_qty = toUInt(row.per_student_qty, 1);

          // normalize prices safely
          const toNum = (v, d = 0) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : d;
          };

          row.mrp = toNum(row.mrp, 0);
          row.sale_price = toNum(row.sale_price, 0);

          // normalize booleans
          row.is_optional =
            row.is_optional === true ||
            row.is_optional === 1 ||
            row.is_optional === "1" ||
            row.is_optional === "true";
        },
      },
      defaultScope: {
        // ✅ IMPORTANT: explicitly select only real columns
        attributes: [
          "id",
          "bundle_id",
          "product_id",
          "qty",
          "per_student_qty", // ✅ NEW
          "mrp",
          "sale_price",
          "is_optional",
          "sort_order",
          "createdAt",
          "updatedAt",
        ],
      },
    }
  );

  BundleItem.associate = (models) => {
    if (models.Bundle) {
      BundleItem.belongsTo(models.Bundle, {
        foreignKey: "bundle_id",
        as: "bundle",
      });
    }

    if (models.Product) {
      BundleItem.belongsTo(models.Product, {
        foreignKey: "product_id",
        as: "product",
      });
    }

    // ❌ DO NOT add Book relation here
    // BundleItem does NOT have book_id column.
  };

  return BundleItem;
};
