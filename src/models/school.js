// src/models/school.js
"use strict";

module.exports = (sequelize, DataTypes) => {
  const School = sequelize.define(
    "School",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },

      contact_person: {
        type: DataTypes.STRING(150),
        allowNull: true,
      },

      phone: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },

      email: {
        type: DataTypes.STRING(150),
        allowNull: true,
        validate: {
          isEmail: true,
        },
      },

      address: {
        type: DataTypes.TEXT,
        allowNull: true,
      },

      city: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },

      state: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },

      pincode: {
        type: DataTypes.STRING(10),
        allowNull: true,
      },

      sort_order: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
        defaultValue: 0,
      },

      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      tableName: "schools",
      timestamps: true,
    }
  );

  /* ============================
   * Associations
   * ============================ */
  School.associate = (models) => {
    // ✅ School → Bundles
    School.hasMany(models.Bundle, {
      foreignKey: "school_id",
      as: "bundles",
    });

    // (Optional – future ready)
    // School.hasMany(models.SchoolOrder, {
    //   foreignKey: "school_id",
    //   as: "orders",
    // });
  };

  return School;
};
