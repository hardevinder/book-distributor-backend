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

      /**
       * ✅ Option A fields (frontend requested)
       * - requested_qty / requested_unit_price = what user entered in POS
       * - issued_qty = what inventory actually allowed (BOOK FIFO) / same as requested for MATERIAL
       *
       * IMPORTANT:
       * - For POS bill/PDF: print requested_qty + (requested_qty * requested_unit_price)
       * - For stock: use issued_qty + short_qty
       */
      requested_qty: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      requested_unit_price: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },

      /**
       * Backward compatible fields (keep)
       * We'll store same as requested_* so older code still works.
       */
      qty: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      unit_price: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },

      /**
       * ✅ Amount should be BILLING amount for receipt/PDF
       * So keep as: requested_qty * requested_unit_price
       * (Do NOT tie it to issued_qty, otherwise PDFs become 0 when stock is 0)
       */
      amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },

      // inventory side (partial stock support)
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

        // ✅ helpful (optional) analytics index
        { fields: ["sale_id", "product_id"], name: "idx_sale_items_sale_product" },
      ],
    }
  );

  SaleItem.associate = (models) => {
    SaleItem.belongsTo(models.Sale, {
      foreignKey: "sale_id",
      as: "sale",
    });

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
