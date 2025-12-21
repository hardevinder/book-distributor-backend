// src/models/bundle.js
"use strict";

module.exports = (sequelize, DataTypes) => {
  const Bundle = sequelize.define(
    "Bundle",
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

      academic_session: {
        type: DataTypes.STRING(20),
        allowNull: false,
      },

      status: {
        type: DataTypes.ENUM(
          "DRAFT",
          "RESERVED",
          "ISSUED",
          "DISPATCHED",
          "DELIVERED",
          "CANCELLED"
        ),
        allowNull: false,
        defaultValue: "RESERVED",
      },

      notes: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
    },
    {
      tableName: "bundles",
      timestamps: true,
    }
  );

  // associations added later (clean separation)
  Bundle.associate = (models) => {
    Bundle.belongsTo(models.School, {
      foreignKey: "school_id",
      as: "school",
    });

    Bundle.hasMany(models.BundleItem, {
      foreignKey: "bundle_id",
      as: "items",
    });

    Bundle.hasMany(models.BundleIssue, {
      foreignKey: "bundle_id",
      as: "issues",
    });
  };

  return Bundle;
};
