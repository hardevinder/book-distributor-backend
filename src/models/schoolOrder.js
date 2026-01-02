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

      order_type: {
        type: DataTypes.ENUM("original", "reorder"),
        allowNull: false,
        defaultValue: "original",
      },

      parent_order_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

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
        type: DataTypes.ENUM(
          "draft",
          "sent",
          "partial_received",
          "completed",
          "cancelled",
          "reordered"
        ),
        allowNull: false,
        defaultValue: "draft",
      },

      remarks: {
        type: DataTypes.TEXT,
        allowNull: true,
      },

      transport_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      transport_id_2: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      // ✅ Note 1 (existing)
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },

      // ✅ Note 2 (new)
      notes_2: {
        type: DataTypes.TEXT,
        allowNull: true,
      },

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

      overall_discount: {
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
        type: DataTypes.DECIMAL(14, 2),
        allowNull: false,
        defaultValue: 0,
      },

      supplier_receipt_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      supplier_receipt_no: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },

      received_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },

      email_sent_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },

      email_sent_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },

      last_email_sent_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },

      last_email_to: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },

      last_email_cc: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },

      last_email_subject: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },

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
        { fields: ["reorder_seq"] },
        { fields: ["order_date"] },
        { fields: ["supplier_receipt_id"] },
        { fields: ["email_sent_count"] },
        { fields: ["last_email_sent_at"] },

        // ✅ helpful compound indexes for reports
        { fields: ["school_id", "order_date"] },
        { fields: ["supplier_id", "order_date"] },
        { fields: ["school_id", "supplier_id", "academic_session"] },

        // ✅ IMPORTANT:
        // We REMOVED uniq_school_session_supplier_type because it blocks multiple reorders.
        // We will enforce "only 1 ORIGINAL per school+session+supplier" via DB migration (generated column trick).
        // And we enforce reorder sequencing per parent via uq_parent_reorder_seq (migration).
      ],
    }
  );

  SchoolOrder.associate = (models) => {
    SchoolOrder.belongsTo(models.School, { foreignKey: "school_id", as: "school" });
    SchoolOrder.belongsTo(models.Supplier, { foreignKey: "supplier_id", as: "supplier" });

    if (models.Transport) {
      SchoolOrder.belongsTo(models.Transport, { foreignKey: "transport_id", as: "transport" });
      SchoolOrder.belongsTo(models.Transport, { foreignKey: "transport_id_2", as: "transport2" });
    }

    // ✅ CRITICAL for ORDERED-side report
    // Ensures SchoolOrder.associations includes target SchoolOrderItem so your dynamic alias detection works.
    if (models.SchoolOrderItem) {
      SchoolOrder.hasMany(models.SchoolOrderItem, {
        foreignKey: "school_order_id",
        as: "items",
        onDelete: "CASCADE",
        hooks: true,
      });
    }

    if (models.SupplierReceipt) {
      SchoolOrder.belongsTo(models.SupplierReceipt, {
        foreignKey: "supplier_receipt_id",
        as: "supplierReceipt",
      });
    }

    // self references for reorders
    SchoolOrder.belongsTo(models.SchoolOrder, { foreignKey: "parent_order_id", as: "parentOrder" });
    SchoolOrder.hasMany(models.SchoolOrder, { foreignKey: "parent_order_id", as: "reorders" });

    if (models.SchoolOrderEmailLog) {
      SchoolOrder.hasMany(models.SchoolOrderEmailLog, {
        foreignKey: "school_order_id",
        as: "emailLogs",
      });
    }
  };

  return SchoolOrder;
};
