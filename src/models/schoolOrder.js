// src/models/schoolOrder.js

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

      order_no: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: true, // e.g. SO-2025-0001
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
        type: DataTypes.ENUM(
          "draft",
          "sent",
          "partial_received",
          "completed",
          "cancelled"
        ),
        allowNull: false,
        defaultValue: "draft",
      },

      remarks: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      tableName: "school_orders",
      timestamps: true,
    }
  );

  SchoolOrder.associate = (models) => {
    SchoolOrder.belongsTo(models.School, {
      foreignKey: "school_id",
      as: "school",
    });

    SchoolOrder.hasMany(models.SchoolOrderItem, {
      foreignKey: "school_order_id",
      as: "items",
    });
  };

  return SchoolOrder;
};
