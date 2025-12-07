// src/models/schoolRequirementOrderLink.js

module.exports = (sequelize, DataTypes) => {
  const SchoolRequirementOrderLink = sequelize.define(
    "SchoolRequirementOrderLink",
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

      school_order_item_id: {
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
      tableName: "school_requirement_order_links",
      timestamps: true,
    }
  );

  SchoolRequirementOrderLink.associate = (models) => {
    SchoolRequirementOrderLink.belongsTo(models.SchoolBookRequirement, {
      foreignKey: "requirement_id",
      as: "requirement",
    });

    SchoolRequirementOrderLink.belongsTo(models.SchoolOrderItem, {
      foreignKey: "school_order_item_id",
      as: "order_item",
    });
  };

  return SchoolRequirementOrderLink;
};
