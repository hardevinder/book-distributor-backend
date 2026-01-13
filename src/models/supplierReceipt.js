"use strict";

module.exports = (sequelize, DataTypes) => {
  const SupplierReceipt = sequelize.define(
    "SupplierReceipt",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      supplier_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      school_order_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      // ✅ NEW: Direct purchase tagging
      school_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      receipt_no: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: true,
      },

      receive_doc_type: {
        type: DataTypes.ENUM("CHALLAN", "INVOICE"),
        allowNull: false,
        defaultValue: "CHALLAN",
      },

      doc_no: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },

      doc_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },

      invoice_no: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },

      invoice_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
      },

      academic_session: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },

      received_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        defaultValue: sequelize.literal("CURRENT_DATE"),
      },

      status: {
        type: DataTypes.ENUM("draft", "received", "cancelled"),
        allowNull: false,
        defaultValue: "draft",
      },

      remarks: {
        type: DataTypes.TEXT,
        allowNull: true,
      },

      posted_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },

      sub_total: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },

      bill_discount_type: {
        type: DataTypes.ENUM("NONE", "PERCENT", "AMOUNT"),
        allowNull: false,
        defaultValue: "NONE",
      },

      bill_discount_value: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true,
      },

      bill_discount_amount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },

      shipping_charge: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },

      other_charge: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },

      round_off: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },

      grand_total: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      tableName: "supplier_receipts",
      timestamps: true,
      indexes: [
        { fields: ["supplier_id", "received_date"] },
        { fields: ["supplier_id", "status"] },
        { fields: ["school_order_id"] },
        { fields: ["school_id"] }, // ✅ NEW index
        { fields: ["supplier_id", "receive_doc_type"] },
        { fields: ["supplier_id", "doc_no"] },
        { fields: ["posted_at"] },
      ],
    }
  );

  SupplierReceipt.associate = (models) => {
    SupplierReceipt.belongsTo(models.Supplier, {
      foreignKey: "supplier_id",
      as: "supplier",
    });

    // ✅ NEW: Direct purchase school link
    if (models.School) {
      SupplierReceipt.belongsTo(models.School, {
        foreignKey: "school_id",
        as: "school",
      });
    }

    if (models.SchoolOrder) {
      SupplierReceipt.belongsTo(models.SchoolOrder, {
        foreignKey: "school_order_id",
        as: "schoolOrder",
      });
    }

    if (models.SupplierReceiptItem) {
      SupplierReceipt.hasMany(models.SupplierReceiptItem, {
        foreignKey: "supplier_receipt_id",
        as: "items",
        onDelete: "CASCADE",
        hooks: true,
      });
    }

    if (models.SupplierLedgerTxn) {
      SupplierReceipt.hasMany(models.SupplierLedgerTxn, {
        foreignKey: "ref_id",
        sourceKey: "id",
        as: "ledgerTxns",
        constraints: false,
        scope: { ref_table: "supplier_receipts" },
      });
    }
  };

  return SupplierReceipt;
};
