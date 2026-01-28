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

        // prevent duplicates inside same bundle
        { unique: true, fields: ["bundle_id", "product_id"] },
      ],
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
  };

  return BundleItem;
};
