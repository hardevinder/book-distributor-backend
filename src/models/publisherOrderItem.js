// src/models/publisherOrderItem.js

module.exports = (sequelize, DataTypes) => {
  const PublisherOrderItem = sequelize.define(
    "PublisherOrderItem",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      publisher_order_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      book_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      // Total quantity ordered from publisher for this book
      total_order_qty: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },

      // ✅ NEW: Quantity actually received from publisher
      received_qty: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },

      unit_price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
      },

      total_amount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true,
      },
    },
    {
      tableName: "publisher_order_items",
      timestamps: true,
    }
  );

  PublisherOrderItem.associate = (models) => {
    PublisherOrderItem.belongsTo(models.PublisherOrder, {
      foreignKey: "publisher_order_id",
      as: "order",
    });

    PublisherOrderItem.belongsTo(models.Book, {
      foreignKey: "book_id",
      as: "book",
    });

    PublisherOrderItem.hasMany(models.RequirementOrderLink, {
      foreignKey: "publisher_order_item_id",
      as: "requirement_links",
    });
  };

  return PublisherOrderItem;
};
