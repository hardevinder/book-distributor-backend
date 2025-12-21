"use strict";

module.exports = (sequelize, DataTypes) => {
  const BundleIssue = sequelize.define(
    "BundleIssue",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      bundle_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },

      issue_no: { type: DataTypes.STRING(20), allowNull: false, unique: true },
      issue_date: { type: DataTypes.DATEONLY, allowNull: false },

      issued_to_type: {
        type: DataTypes.ENUM("SCHOOL", "DISTRIBUTOR"),
        allowNull: false,
        defaultValue: "SCHOOL",
      },

      issued_to_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },

      issued_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      remarks: { type: DataTypes.STRING(255), allowNull: true },

      // ✅ ADD THESE
      status: {
        type: DataTypes.ENUM("ISSUED", "CANCELLED"),
        allowNull: false,
        defaultValue: "ISSUED",
      },
      cancelled_at: { type: DataTypes.DATE, allowNull: true },
      cancelled_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    },
    {
      tableName: "bundle_issues",
      timestamps: true,
      indexes: [
        { fields: ["bundle_id"], name: "idx_bundle_issue_bundle" },
        { fields: ["issued_to_type", "issued_to_id"], name: "idx_issue_to" },
        { unique: true, fields: ["issue_no"], name: "uk_issue_no" },

        // ✅ helpful for filtering
        { fields: ["status"], name: "idx_issue_status" },
        { fields: ["issue_date"], name: "idx_issue_date" },
      ],
    }
  );

  BundleIssue.associate = (models) => {
    BundleIssue.belongsTo(models.Bundle, {
      foreignKey: "bundle_id",
      as: "bundle",
    });

    // Issued by user (optional)
    if (models.User) {
      BundleIssue.belongsTo(models.User, {
        foreignKey: "issued_by",
        as: "issuer",
      });
    }

    // ✅ cancelled_by user link (optional)
    if (models.User) {
      BundleIssue.belongsTo(models.User, {
        foreignKey: "cancelled_by",
        as: "canceller",
      });
    }

    // Polymorphic target:
    BundleIssue.belongsTo(models.School, {
      foreignKey: "issued_to_id",
      constraints: false,
      as: "issuedSchool",
    });

    BundleIssue.belongsTo(models.Distributor, {
      foreignKey: "issued_to_id",
      constraints: false,
      as: "issuedDistributor",
    });

    // Dispatch record (optional)
    if (models.BundleDispatch) {
      BundleIssue.hasMany(models.BundleDispatch, {
        foreignKey: "bundle_issue_id",
        as: "dispatches",
      });
    }
  };

  return BundleIssue;
};
