// src/models/schoolRequirementOrderLink.js

module.exports = (sequelize, DataTypes) => {
  const RequirementOrderLink = sequelize.define(
    "RequirementOrderLink",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      requirement_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      // ✅ matches DB column name
      publisher_order_item_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      allocated_qty: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      // ✅ matches DB table name
      tableName: "requirement_order_links",
      timestamps: true,
    }
  );

  RequirementOrderLink.associate = (models) => {
    RequirementOrderLink.belongsTo(models.SchoolBookRequirement, {
      foreignKey: "requirement_id",
      as: "requirement",
    });

    // If you have PublisherOrderItem model
    if (models.PublisherOrderItem) {
      RequirementOrderLink.belongsTo(models.PublisherOrderItem, {
        foreignKey: "publisher_order_item_id",
        as: "publisher_order_item",
      });
    }
  };

  return RequirementOrderLink;
};