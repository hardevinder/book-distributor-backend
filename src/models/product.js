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
       * BOOK  -> auto-created from books
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
       * Category (mostly for MATERIAL)
       * - recommended/required when type = MATERIAL
       * - optional for BOOK (you can still categorize books if you want)
       */
      category_id: {
        type: DataTypes.INTEGER.UNSIGNED,
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
       * - unique(type, book_id) ensures one BOOK product per book
       */
      indexes: [
        { fields: ["type"] },
        { fields: ["book_id"] },
        { fields: ["category_id"] },
        { fields: ["is_active"] },
        {
          unique: true,
          fields: ["type", "book_id"],
          name: "uniq_book_product",
        },
      ],

      /**
       * Extra safety at model level
       * ✅ Updated: adds category rules for MATERIAL
       */
      validate: {
        productTypeRules() {
          const t = String(this.type || "").toUpperCase();

          if (t === "BOOK") {
            // book_id must be a positive integer
            const bid = Number(this.book_id);
            if (!Number.isFinite(bid) || bid <= 0) {
              throw new Error("BOOK product must have valid book_id");
            }

            // Optional strict rules for BOOK (keep relaxed)
            // const nm = String(this.name || "").trim();
            // if (nm) throw new Error("BOOK product should not have name");

            // category_id is optional for BOOK
          }

          if (t === "MATERIAL") {
            const nm = String(this.name || "").trim();
            if (!nm) {
              throw new Error("MATERIAL product must have name");
            }

            // ✅ Recommended: MATERIAL must have category_id
            const cid = Number(this.category_id);
            if (!Number.isFinite(cid) || cid <= 0) {
              throw new Error("MATERIAL product must have valid category_id");
            }

            // Optional strict enforcement:
            // book_id should be null for MATERIAL
            // const bid = Number(this.book_id);
            // if (Number.isFinite(bid) && bid > 0) {
            //   throw new Error("MATERIAL product must not have book_id");
            // }
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

    // ✅ NEW: Category link
    if (models.ProductCategory) {
      Product.belongsTo(models.ProductCategory, {
        foreignKey: "category_id",
        as: "category",
      });
    }

    // ✅ OPTIONAL (recommended): if you store product_id in bundle_items
    if (models.BundleItem) {
      Product.hasMany(models.BundleItem, {
        foreignKey: "product_id",
        as: "bundleItems",
      });
    }

    // ✅ OPTIONAL: if you have InventoryTxn / InventoryBatch by product
    if (models.InventoryTxn) {
      Product.hasMany(models.InventoryTxn, {
        foreignKey: "product_id",
        as: "inventoryTxns",
      });
    }
    if (models.InventoryBatch) {
      Product.hasMany(models.InventoryBatch, {
        foreignKey: "product_id",
        as: "inventoryBatches",
      });
    }
  };

  return Product;
};
