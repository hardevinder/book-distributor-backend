// src/models/schoolOrderItem.js
"use strict";

module.exports = (sequelize, DataTypes) => {
  const SchoolOrderItem = sequelize.define(
    "SchoolOrderItem",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      school_order_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      book_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      total_order_qty: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },

      // ✅ Normal received (non-specimen)
      received_qty: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },

      // ✅ NEW: Specimen received (kept separate from received_qty)
      specimen_received_qty: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: "Specimen qty received (do not mix with received_qty)",
      },

      // ✅ qty shifted to re-order (do NOT delete history)
      reordered_qty: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: "Quantity transferred to re-order orders",
      },

      // 🔥 COMMERCIAL FIELDS (RECEIVE TIME)

      unit_price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
      },

      discount_pct: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: true,
      },

      discount_amt: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
      },

      net_unit_price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
      },

      line_amount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true,
      },
    },
    {
      tableName: "school_order_items",
      timestamps: true,
      indexes: [
        // speeds up lookups used in bumpOrderReceivedQty()
        { fields: ["school_order_id", "book_id"], unique: true },

        // optional but useful for reports
        { fields: ["school_order_id"] },
        { fields: ["book_id"] },
      ],
    }
  );

  SchoolOrderItem.associate = (models) => {
    SchoolOrderItem.belongsTo(models.SchoolOrder, {
      foreignKey: "school_order_id",
      as: "order",
    });

    SchoolOrderItem.belongsTo(models.Book, {
      foreignKey: "book_id",
      as: "book",
    });

    SchoolOrderItem.hasMany(models.SchoolRequirementOrderLink, {
      foreignKey: "school_order_item_id",
      as: "requirement_links",
    });
  };

  return SchoolOrderItem;
};
