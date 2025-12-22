"use strict";

module.exports = (sequelize, DataTypes) => {
  const SupplierReceiptItem = sequelize.define(
    "SupplierReceiptItem",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      supplier_receipt_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      book_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      /* =========================================================
       * ✅ NEW STANDARD FIELDS (match SchoolOrderItem + controller)
       * ========================================================= */

      ordered_qty: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
        defaultValue: 0,
      },

      received_qty: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
        defaultValue: 0,
      },

      unit_price: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true,
        defaultValue: 0,
      },

      discount_pct: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: true,
        defaultValue: 0,
      },

      discount_amt: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true,
        defaultValue: 0,
      },

      net_unit_price: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true,
        defaultValue: 0,
      },

      line_amount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true,
        defaultValue: 0,
      },

      /* =========================================================
       * ✅ LEGACY FIELDS (keep for backward compatibility)
       * - You can remove later after data migration + UI updates
       * ========================================================= */

      // legacy single qty
      qty: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },

      // legacy unit rate
      rate: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },

      // legacy discount type/value
      item_discount_type: {
        type: DataTypes.ENUM("NONE", "PERCENT", "AMOUNT"),
        allowNull: false,
        defaultValue: "NONE",
      },

      item_discount_value: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true,
      },

      // legacy computed/stored
      gross_amount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },

      discount_amount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },

      net_amount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      tableName: "supplier_receipt_items",
      timestamps: true,
      indexes: [
        { fields: ["supplier_receipt_id"] },
        { fields: ["book_id"] },

        // ✅ prevent duplicates per receipt+book (recommended)
        { unique: true, fields: ["supplier_receipt_id", "book_id"] },
      ],
    }
  );

  SupplierReceiptItem.associate = (models) => {
    SupplierReceiptItem.belongsTo(models.SupplierReceipt, {
      foreignKey: "supplier_receipt_id",
      as: "receipt",
    });

    SupplierReceiptItem.belongsTo(models.Book, {
      foreignKey: "book_id",
      as: "book",
    });
  };

  return SupplierReceiptItem;
};
