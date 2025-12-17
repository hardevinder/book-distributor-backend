// src/models/inventoryBatch.js
"use strict";

module.exports = (sequelize, DataTypes) => {
  const InventoryBatch = sequelize.define(
    "InventoryBatch",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      book_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      supplier_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      school_order_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      school_order_item_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      purchase_price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
      },

      received_qty: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },

      available_qty: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      tableName: "inventory_batches",
      timestamps: true,
    }
  );

  InventoryBatch.associate = (models) => {
    InventoryBatch.belongsTo(models.Book, {
      foreignKey: "book_id",
      as: "book",
    });

    InventoryBatch.belongsTo(models.Supplier, {
      foreignKey: "supplier_id",
      as: "supplier",
    });

    // Source order reference (optional)
    InventoryBatch.belongsTo(models.SchoolOrder, {
      foreignKey: "school_order_id",
      as: "schoolOrder",
    });

    // Source order item reference (optional)
    InventoryBatch.belongsTo(models.SchoolOrderItem, {
      foreignKey: "school_order_item_id",
      as: "schoolOrderItem",
    });

    InventoryBatch.hasMany(models.InventoryTxn, {
      foreignKey: "batch_id",
      as: "txns",
    });
  };

  return InventoryBatch;
};
