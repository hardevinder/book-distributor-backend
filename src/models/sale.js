"use strict";

module.exports = (sequelize, DataTypes) => {
  const Sale = sequelize.define(
    "Sale",
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      sale_no: { type: DataTypes.STRING(30), allowNull: false, unique: true },
      sale_date: { type: DataTypes.DATEONLY, allowNull: false },

      sold_to_type: {
        type: DataTypes.ENUM("SCHOOL", "WALKIN", "DISTRIBUTOR"),
        allowNull: false,
        defaultValue: "WALKIN",
      },
      sold_to_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },

      bundle_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
      class_name: { type: DataTypes.STRING(50), allowNull: true },

      status: {
        type: DataTypes.ENUM("DRAFT", "COMPLETED", "CANCELLED"),
        allowNull: false,
        defaultValue: "COMPLETED",
      },

      subtotal: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      discount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      tax: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      total_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },

      payment_mode: {
        type: DataTypes.ENUM("CASH", "UPI", "CARD", "CREDIT", "MIXED"),
        allowNull: false,
        defaultValue: "CASH",
      },

      paid_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      balance_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },

      notes: { type: DataTypes.TEXT, allowNull: true },

      // ✅ Sold-by record (seller)
      created_by: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },

      // ✅ Cancel tracking
      cancelled_at: { type: DataTypes.DATE, allowNull: true },
      cancelled_by: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    },
    {
      tableName: "sales",
      timestamps: true,
      indexes: [
        { unique: true, fields: ["sale_no"], name: "uk_sale_no" },

        { fields: ["sale_date"], name: "idx_sales_date" },
        { fields: ["status"], name: "idx_sales_status" },

        { fields: ["sold_to_type", "sold_to_id"], name: "idx_sales_customer" },
        { fields: ["bundle_id"], name: "idx_sales_bundle" },

        // ✅ for "sold by whom" filters / distributor restrictions
        { fields: ["created_by"], name: "idx_sales_created_by" },

        // ✅ for audit
        { fields: ["cancelled_by"], name: "idx_sales_cancelled_by" },

        // ✅ common report query: per seller per day
        { fields: ["sale_date", "created_by"], name: "idx_sales_date_created_by" },
      ],
    }
  );

  Sale.associate = (models) => {
    // ✅ items
    if (models.SaleItem) {
      Sale.hasMany(models.SaleItem, {
        foreignKey: "sale_id",
        as: "items",
        onDelete: "CASCADE",
        hooks: true,
      });
    }

    // ✅ bundle link (optional)
    if (models.Bundle) {
      Sale.belongsTo(models.Bundle, {
        foreignKey: "bundle_id",
        as: "bundle",
      });
    }

    // ✅ sold_to polymorphic
    if (models.School) {
      Sale.belongsTo(models.School, {
        foreignKey: "sold_to_id",
        constraints: false,
        as: "soldSchool",
      });
    }
    if (models.Distributor) {
      Sale.belongsTo(models.Distributor, {
        foreignKey: "sold_to_id",
        constraints: false,
        as: "soldDistributor",
      });
    }

    // ✅ created_by user (sold by whom)
    if (models.User) {
      Sale.belongsTo(models.User, {
        foreignKey: "created_by",
        as: "creator",
      });
    }

    // ✅ cancelled_by user (audit)
    if (models.User) {
      Sale.belongsTo(models.User, {
        foreignKey: "cancelled_by",
        as: "canceller",
      });
    }
  };

  return Sale;
};
