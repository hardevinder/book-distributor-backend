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

      /**
       * BOOK  -> auto-created from books (Option A)
       * MATERIAL -> stationery / other items
       */
      type: {
        type: DataTypes.ENUM("BOOK", "MATERIAL"),
        allowNull: false,
        defaultValue: "MATERIAL",
      },

      /**
       * BOOK linkage
       * - required when type = BOOK
       * - null for MATERIAL
       */
      book_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      /**
       * MATERIAL name
       * - required when type = MATERIAL
       * - null for BOOK (title comes from Book table)
       */
      name: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },

      /**
       * Unit of Measure
       * PCS default is fine for books also
       */
      uom: {
        type: DataTypes.STRING(30),
        allowNull: false,
        defaultValue: "PCS",
      },

      /**
       * Soft enable/disable product
       */
      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      tableName: "products",
      timestamps: true,

      /**
       * Indexes
       * - unique(type, book_id) ensures:
       *   👉 one BOOK product per book
       */
      indexes: [
        { fields: ["type"] },
        { fields: ["book_id"] },
        { fields: ["is_active"] },
        {
          unique: true,
          fields: ["type", "book_id"],
          name: "uniq_book_product",
        },
      ],

      /**
       * Extra safety at model level
       */
      validate: {
        productTypeRules() {
          if (this.type === "BOOK" && !this.book_id) {
            throw new Error("BOOK product must have book_id");
          }

          if (this.type === "MATERIAL" && !this.name) {
            throw new Error("MATERIAL product must have name");
          }
        },
      },
    }
  );

  /* ============================
   * Associations
   * ============================ */
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
