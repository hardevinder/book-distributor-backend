"use strict";

module.exports = (sequelize, DataTypes) => {
  const SupplierReceiptOrderLink = sequelize.define(
    "SupplierReceiptOrderLink",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      supplier_receipt_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      school_order_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },
    },
    {
      tableName: "supplier_receipt_order_links",
      timestamps: true,
    }
  );

  SupplierReceiptOrderLink.associate = (models) => {
    // Receipt → Links
    SupplierReceiptOrderLink.belongsTo(models.SupplierReceipt, {
      foreignKey: "supplier_receipt_id",
      as: "receipt",
    });

    // Order → Links
    SupplierReceiptOrderLink.belongsTo(models.SchoolOrder, {
      foreignKey: "school_order_id",
      as: "school_order",
    });
  };

  return SupplierReceiptOrderLink;
};