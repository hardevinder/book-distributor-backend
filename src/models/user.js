"use strict";

module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define(
    "User",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },

      email: {
        type: DataTypes.STRING(150),
        allowNull: false,
        unique: true,
      },

      phone: {
        type: DataTypes.STRING(30),
        allowNull: true,
      },

      password_hash: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },

      role: {
        type: DataTypes.ENUM("superadmin", "distributor", "school", "staff"),
        allowNull: false,
        defaultValue: "distributor",
      },

      // ✅ LINK TO DISTRIBUTOR
      distributor_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },

      last_login_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: "users",
      timestamps: true,
    }
  );

  // ✅ THIS WAS MISSING (CRITICAL)
  User.associate = (models) => {
    User.belongsTo(models.Distributor, {
      foreignKey: "distributor_id",
      as: "distributor",
    });
  };

  return User;
};
