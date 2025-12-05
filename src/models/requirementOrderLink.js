// src/models/requirementOrderLink.js

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
      tableName: "requirement_order_links",
      timestamps: true,
    }
  );

  RequirementOrderLink.associate = (models) => {
    RequirementOrderLink.belongsTo(models.SchoolBookRequirement, {
      foreignKey: "requirement_id",
      as: "requirement",
    });

    RequirementOrderLink.belongsTo(models.PublisherOrderItem, {
      foreignKey: "publisher_order_item_id",
      as: "order_item",
    });
  };

  return RequirementOrderLink;
};
