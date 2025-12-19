// src/models/bundleItem.js
"use strict";

module.exports = (sequelize, DataTypes) => {
  const BundleItem = sequelize.define(
    "BundleItem",
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },

      bundle_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      book_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },

      qty: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    {
      tableName: "bundle_items",
      timestamps: true,
    }
  );

  return BundleItem;
};
