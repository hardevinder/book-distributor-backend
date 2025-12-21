"use strict";

module.exports = (sequelize, DataTypes) => {
  const BundleDispatch = sequelize.define(
    "BundleDispatch",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      // ✅ NEW: Delivery Challan Number
      challan_no: {
        type: DataTypes.STRING(50),
        allowNull: true,
        unique: true,
      },

      bundle_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      bundle_issue_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

      transport_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

      vehicle_no: { type: DataTypes.STRING(30), allowNull: true },
      driver_name: { type: DataTypes.STRING(100), allowNull: true },
      driver_mobile: { type: DataTypes.STRING(15), allowNull: true },

      dispatch_date: { type: DataTypes.DATEONLY, allowNull: false },
      expected_delivery_date: { type: DataTypes.DATEONLY, allowNull: true },
      delivered_date: { type: DataTypes.DATEONLY, allowNull: true },

      status: {
        type: DataTypes.ENUM("DISPATCHED", "PARTIALLY_DELIVERED", "DELIVERED"),
        allowNull: false,
        defaultValue: "DISPATCHED",
      },

      remarks: { type: DataTypes.STRING(255), allowNull: true },
    },
    {
      tableName: "bundle_dispatches",
      timestamps: true,
      indexes: [
        { fields: ["bundle_id"], name: "idx_dispatch_bundle" },
        { fields: ["bundle_issue_id"], name: "idx_dispatch_issue" },
        { fields: ["transport_id"], name: "idx_dispatch_transport" },

        // ✅ NEW indexes
        { fields: ["challan_no"], name: "idx_dispatch_challan_no", unique: true },
        { fields: ["status"], name: "idx_dispatch_status" },
        { fields: ["dispatch_date"], name: "idx_dispatch_dispatch_date" },
      ],
    }
  );

  BundleDispatch.associate = (models) => {
    BundleDispatch.belongsTo(models.Bundle, {
      foreignKey: "bundle_id",
      as: "bundle",
    });

    if (models.BundleIssue) {
      BundleDispatch.belongsTo(models.BundleIssue, {
        foreignKey: "bundle_issue_id",
        as: "issue",
      });
    }

    if (models.Transport) {
      BundleDispatch.belongsTo(models.Transport, {
        foreignKey: "transport_id",
        as: "transport",
      });
    }
  };

  return BundleDispatch;
};
