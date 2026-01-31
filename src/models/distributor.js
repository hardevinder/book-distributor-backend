"use strict";

module.exports = (sequelize, DataTypes) => {
  const Distributor = sequelize.define(
    "Distributor",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      name: {
        type: DataTypes.STRING(150),
        allowNull: false,
      },

      mobile: {
        type: DataTypes.STRING(15),
        allowNull: true,
      },

      email: {
        type: DataTypes.STRING(150),
        allowNull: true,
      },

      address: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },

      city: {
        type: DataTypes.STRING(80),
        allowNull: true,
      },

      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      tableName: "distributors",
      timestamps: true,
    }
  );

  Distributor.associate = (models) => {
    // ✅ Existing polymorphic relation (KEEP AS-IS)
    Distributor.hasMany(models.BundleIssue, {
      foreignKey: "issued_to_id",
      constraints: false, // polymorphic
      scope: { issued_to_type: "DISTRIBUTOR" },
      as: "issues",
    });

    // ✅ OPTIONAL but recommended: link distributor users
    Distributor.hasMany(models.User, {
      foreignKey: "distributor_id",
      as: "users",
    });
  };

  return Distributor;
};
