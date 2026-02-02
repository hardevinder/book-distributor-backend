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

      qty: {
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
        { fields: ["bundle_id"] },
        { fields: ["product_id"] },
        { unique: true, fields: ["bundle_id", "product_id"] },
      ],
      defaultScope: {
        // ✅ IMPORTANT: explicitly select only real columns
        attributes: [
          "id",
          "bundle_id",
          "product_id",
          "qty",
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
