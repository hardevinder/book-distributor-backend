// src/models/schoolOrder.js
"use strict";

module.exports = (sequelize, DataTypes) => {
  const SchoolOrder = sequelize.define(
    "SchoolOrder",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      school_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      // ✅ supplier-wise order
      supplier_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      order_no: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: true,
      },

      academic_session: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },

      // ✅ NEW (Option-1): original vs reorder
      order_type: {
        type: DataTypes.ENUM("original", "reorder"),
        allowNull: false,
        defaultValue: "original",
      },

      // ✅ NEW (optional but recommended): link reorder -> original order
      parent_order_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      // ✅ NEW (optional): reorder number sequence for same parent (1,2,3...)
      reorder_seq: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      order_date: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },

      status: {
        type: DataTypes.ENUM("draft", "sent", "partial_received", "completed", "cancelled"),
        allowNull: false,
        defaultValue: "draft",
      },

      remarks: {
        type: DataTypes.TEXT,
        allowNull: true,
      },

      // FK → transports.id (Option 1)
      transport_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      // “Through” text (Option 1)
      transport_through: {
        type: DataTypes.STRING(150),
        allowNull: true,
      },

      // ✅ Option 2 transport
      transport_id_2: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      // ✅ “Through” text (Option 2)
      transport_through_2: {
        type: DataTypes.STRING(150),
        allowNull: true,
      },

      // Notes (will be printed highlighted in footer)
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },

      /* =======================================================
       * ✅ Commercial / Ledger fields (Order level)
       * ======================================================= */

      freight_charges: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },

      packing_charges: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },

      other_charges: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },

      // overall discount on whole order (₹)
      overall_discount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },

      // +/- adjustment
      round_off: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },

      // final payable total (₹)
      grand_total: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: false,
        defaultValue: 0,
      },

      /* =======================================================
       * ✅ NEW: Link SchoolOrder -> SupplierReceipt (Option A)
       * ======================================================= */

      supplier_receipt_id: {
        // links supplier_receipts.id
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      supplier_receipt_no: {
        // convenience snapshot like SR-2025-12-000001
        type: DataTypes.STRING(50),
        allowNull: true,
      },

      received_at: {
        // optional: first time receive completed
        type: DataTypes.DATE,
        allowNull: true,
      },

      // optional: when email sent (if your DB has/needs it)
      email_sent_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },

      // ✅ NEW: Supplier Bill No captured during receiving
      bill_no: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
    },
    {
      tableName: "school_orders",
      timestamps: true,
      indexes: [
        { fields: ["school_id"] },
        { fields: ["supplier_id"] },
        { fields: ["academic_session"] },
        { fields: ["order_type"] },
        { fields: ["parent_order_id"] },
        { fields: ["order_date"] },
        { fields: ["supplier_receipt_id"] },

        // ✅ IMPORTANT: allows 1 original + many reorders for same school/supplier/session
        // (You must also DROP old uniq_school_session_supplier on DB)
        {
          name: "uniq_school_session_supplier_type",
          unique: true,
          fields: ["school_id", "academic_session", "supplier_id", "order_type"],
        },
      ],
    }
  );

  SchoolOrder.associate = (models) => {
    SchoolOrder.belongsTo(models.School, {
      foreignKey: "school_id",
      as: "school",
    });

    SchoolOrder.belongsTo(models.Supplier, {
      foreignKey: "supplier_id",
      as: "supplier",
    });

    // ✅ Option 1 transport
    SchoolOrder.belongsTo(models.Transport, {
      foreignKey: "transport_id",
      as: "transport",
    });

    // ✅ Option 2 transport
    SchoolOrder.belongsTo(models.Transport, {
      foreignKey: "transport_id_2",
      as: "transport2",
    });

    SchoolOrder.hasMany(models.SchoolOrderItem, {
      foreignKey: "school_order_id",
      as: "items",
    });

    // ✅ optional association: SchoolOrder -> SupplierReceipt
    if (models.SupplierReceipt) {
      SchoolOrder.belongsTo(models.SupplierReceipt, {
        foreignKey: "supplier_receipt_id",
        as: "supplierReceipt",
      });
    }

    // ✅ NEW: self association (reorder -> parent original)
    SchoolOrder.belongsTo(models.SchoolOrder, {
      foreignKey: "parent_order_id",
      as: "parentOrder",
    });

    // ✅ NEW: original -> many reorders
    SchoolOrder.hasMany(models.SchoolOrder, {
      foreignKey: "parent_order_id",
      as: "reorders",
    });
  };

  return SchoolOrder;
};
