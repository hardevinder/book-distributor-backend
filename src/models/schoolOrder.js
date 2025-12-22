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
    },
    {
      tableName: "school_orders",
      timestamps: true,
      // indexes: [
      //   { fields: ["school_id"] },
      //   { fields: ["supplier_id"] },
      //   { fields: ["academic_session"] },
      //   { fields: ["order_date"] },
      //   { fields: ["supplier_receipt_id"] },
      // ],
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
  };

  return SchoolOrder;
};
