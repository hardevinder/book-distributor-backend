"use strict";

module.exports = (sequelize, DataTypes) => {
  const Product = sequelize.define(
    "Product",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      type: {
        type: DataTypes.ENUM("BOOK", "MATERIAL"),
        allowNull: false,
        defaultValue: "MATERIAL",
      },

      // when type=BOOK
      book_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      // when type=MATERIAL
      name: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },

      uom: {
        type: DataTypes.STRING(30),
        allowNull: true,
        defaultValue: "PCS",
      },

      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      tableName: "products",
      timestamps: true,
      indexes: [
        { fields: ["type"] },
        { fields: ["book_id"] },
        { fields: ["is_active"] },
        { unique: true, fields: ["type", "book_id"] }, // prevents duplicate BOOK product rows
      ],
    }
  );

  Product.associate = (models) => {
    if (models.Book) {
      Product.belongsTo(models.Book, {
        foreignKey: "book_id",
        as: "book",
      });
    }
  };

  return Product;
};
