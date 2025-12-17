// src/models/inventoryTxn.js
"use strict";

module.exports = (sequelize, DataTypes) => {
  const InventoryTxn = sequelize.define(
    "InventoryTxn",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      txn_type: {
        type: DataTypes.ENUM("IN", "RESERVE", "UNRESERVE", "OUT"),
        allowNull: false,
      },

      book_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      batch_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      qty: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },

      ref_type: {
        type: DataTypes.STRING(40),
        allowNull: false,
      },

      ref_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      notes: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
    },
    {
      tableName: "inventory_txns",
      timestamps: true,
    }
  );

  InventoryTxn.associate = (models) => {
    InventoryTxn.belongsTo(models.Book, {
      foreignKey: "book_id",
      as: "book",
    });

    InventoryTxn.belongsTo(models.InventoryBatch, {
      foreignKey: "batch_id",
      as: "batch",
    });
  };

  return InventoryTxn;
};
