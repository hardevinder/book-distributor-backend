"use strict";

module.exports = (sequelize, DataTypes) => {
  const ProductCategory = sequelize.define(
    "ProductCategory",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      /**
       * Category name (unique)
       * Examples: Stationery, Notebooks, Sports, Uniform, Bags
       */
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },

      /**
       * Optional description
       */
      description: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },

      /**
       * Soft enable/disable
       */
      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      tableName: "product_categories",
      timestamps: true,

      indexes: [
        { unique: true, fields: ["name"], name: "uniq_product_categories_name" },
        { fields: ["is_active"] },
      ],

      validate: {
        categoryRules() {
          const nm = String(this.name || "").trim();
          if (!nm) throw new Error("Category name is required");
        },
      },

      hooks: {
        // keep name trimmed (and optionally normalized)
        beforeValidate(cat) {
          if (cat.name != null) cat.name = String(cat.name).trim();
          if (cat.description != null) cat.description = String(cat.description).trim();
        },
      },
    }
  );

  /* ============================
   * Associations
   * ============================ */
  ProductCategory.associate = (models) => {
    if (models.Product) {
      ProductCategory.hasMany(models.Product, {
        foreignKey: "category_id",
        as: "products",
      });
    }
  };

  return ProductCategory;
};
