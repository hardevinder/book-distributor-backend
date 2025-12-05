// src/models/class.js
module.exports = (sequelize, DataTypes) => {
  const Class = sequelize.define(
    "Class",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      class_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: true, // ⭐ No duplicate class names
      },

      sort_order: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
        defaultValue: 0, // ⭐ For ordered dropdown
      },

      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      tableName: "classes",
      timestamps: true,
    }
  );

  return Class;
};
