// src/models/bundleItem.js
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

      book_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      // ✅ renamed from qty
      required_qty: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },

      // ✅ new
      reserved_qty: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },

      // ✅ new
      issued_qty: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      tableName: "bundle_items",
      timestamps: true,
      indexes: [
        {
          unique: true,
          fields: ["bundle_id", "book_id"],
          name: "uk_bundle_book",
        },
      ],
    }
  );

  BundleItem.associate = (models) => {
    BundleItem.belongsTo(models.Bundle, {
      foreignKey: "bundle_id",
      as: "bundle",
      onDelete: "CASCADE",
    });

    BundleItem.belongsTo(models.Book, {
      foreignKey: "book_id",
      as: "book",
    });
  };

  return BundleItem;
};
