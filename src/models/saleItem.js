"use strict";

module.exports = (sequelize, DataTypes) => {
  const SaleItem = sequelize.define(
    "SaleItem",
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      sale_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },

      product_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
      book_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },

      kind: {
        type: DataTypes.ENUM("BOOK", "MATERIAL"),
        allowNull: false,
        defaultValue: "BOOK",
      },

      title_snapshot: { type: DataTypes.STRING(255), allowNull: false },
      class_name_snapshot: { type: DataTypes.STRING(50), allowNull: true },

      qty: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      unit_price: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },

      // for partial stock sale support
      issued_qty: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      short_qty: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    },
    {
      tableName: "sale_items",
      timestamps: true,
      indexes: [
        { fields: ["sale_id"], name: "idx_sale_items_sale" },
        { fields: ["product_id"], name: "idx_sale_items_product" },
        { fields: ["book_id"], name: "idx_sale_items_book" },
      ],
    }
  );

  SaleItem.associate = (models) => {
    SaleItem.belongsTo(models.Sale, {
      foreignKey: "sale_id",
      as: "sale",
    });

    // optional: product/book references
    if (models.Product) {
      SaleItem.belongsTo(models.Product, {
        foreignKey: "product_id",
        as: "product",
      });
    }
    if (models.Book) {
      SaleItem.belongsTo(models.Book, {
        foreignKey: "book_id",
        as: "book",
      });
    }
  };

  return SaleItem;
};
