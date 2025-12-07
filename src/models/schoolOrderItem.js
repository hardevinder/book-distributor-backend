// src/models/schoolOrderItem.js

module.exports = (sequelize, DataTypes) => {
  const SchoolOrderItem = sequelize.define(
    "SchoolOrderItem",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      school_order_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      book_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      total_order_qty: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },

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
      tableName: "school_order_items",
      timestamps: true,
    }
  );

  SchoolOrderItem.associate = (models) => {
    SchoolOrderItem.belongsTo(models.SchoolOrder, {
      foreignKey: "school_order_id",
      as: "order",
    });

    SchoolOrderItem.belongsTo(models.Book, {
      foreignKey: "book_id",
      as: "book",
    });

    // 🔹 new link table specific to school orders
    SchoolOrderItem.hasMany(models.SchoolRequirementOrderLink, {
      foreignKey: "school_order_item_id",
      as: "requirement_links",
    });
  };

  return SchoolOrderItem;
};
