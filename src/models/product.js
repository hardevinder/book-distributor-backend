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
        // ✅ Better default: most products you create manually are MATERIAL,
        // but if your system auto-creates BOOK products, it's fine either way.
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
       * ✅ FIX: robust trimming + allow book_id=0 check + allow empty string name check
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

            // For BOOK, name should ideally be null/empty (optional)
            // We won't enforce, but if you want strict:
            // if (this.name) throw new Error("BOOK product should not have name");
          }

          if (t === "MATERIAL") {
            const nm = String(this.name || "").trim();
            if (!nm) {
              throw new Error("MATERIAL product must have name");
            }
            // For MATERIAL, book_id should be null (optional strict enforcement)
            // if (this.book_id) throw new Error("MATERIAL product must not have book_id");
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

    // ✅ OPTIONAL (recommended): if you store product_id in bundle_items
    // This won't break anything if BundleItem model exists.
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
