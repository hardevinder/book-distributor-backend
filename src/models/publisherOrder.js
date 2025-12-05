// src/models/publisherOrder.js

module.exports = (sequelize, DataTypes) => {
  const PublisherOrder = sequelize.define(
    "PublisherOrder",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      publisher_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      order_no: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: true, // e.g. PUB-2025-0001
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
      tableName: "publisher_orders",
      timestamps: true,
    }
  );

  PublisherOrder.associate = (models) => {
    PublisherOrder.belongsTo(models.Publisher, {
      foreignKey: "publisher_id",
      as: "publisher",
    });

    PublisherOrder.hasMany(models.PublisherOrderItem, {
      foreignKey: "publisher_order_id",
      as: "items",
    });
  };

  return PublisherOrder;
};
