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
       * ✅ SPECIMEN FIELDS (NEW)
       * ========================================================= */
      is_specimen: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },

      specimen_reason: {
        type: DataTypes.STRING(255),
        allowNull: true,
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
       * ========================================================= */

      qty: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },

      rate: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },

      item_discount_type: {
        type: DataTypes.ENUM("NONE", "PERCENT", "AMOUNT"),
        allowNull: false,
        defaultValue: "NONE",
      },

      item_discount_value: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true,
      },

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
        { fields: ["is_specimen"] },

        // ✅ OPTIONAL (allowed): helps searching / listing
        { fields: ["supplier_receipt_id", "book_id", "is_specimen"] },

        // ❌ IMPORTANT: removed unique index on (supplier_receipt_id, book_id)
        // because we need 2 rows for same book: paid + specimen
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
