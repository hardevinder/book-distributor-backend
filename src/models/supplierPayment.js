
"use strict";

module.exports = (sequelize, DataTypes) => {
  const SupplierPayment = sequelize.define(
    "SupplierPayment",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      supplier_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      payment_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },

      amount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },

      mode: {
        type: DataTypes.ENUM("CASH", "UPI", "BANK", "CHEQUE", "OTHER"),
        allowNull: false,
        defaultValue: "CASH",
      },

      ref_no: {
        type: DataTypes.STRING(80),
        allowNull: true,
      },

      narration: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },

      created_by: {
        type: DataTypes.STRING(80),
        allowNull: true,
      },
    },
    {
      tableName: "supplier_payments",
      timestamps: true,
      indexes: [{ fields: ["supplier_id", "payment_date"] }],
    }
  );

  SupplierPayment.associate = (models) => {
    SupplierPayment.belongsTo(models.Supplier, {
      foreignKey: "supplier_id",
      as: "supplier",
    });

    // optional reverse relation later:
    // SupplierPayment.hasMany(models.SupplierLedgerTxn, { ... })
  };

  return SupplierPayment;
};
