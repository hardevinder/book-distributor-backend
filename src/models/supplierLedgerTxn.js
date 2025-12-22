"use strict";

module.exports = (sequelize, DataTypes) => {
  const SupplierLedgerTxn = sequelize.define(
    "SupplierLedgerTxn",
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

      txn_date: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },

      txn_type: {
        type: DataTypes.ENUM(
          "PURCHASE_RECEIVE", // ✅ auto on receive save (GRN / invoice)
          "PAYMENT",          // ✅ manual payment entry
          "CREDIT_NOTE",
          "DEBIT_NOTE",
          "ADJUSTMENT"
        ),
        allowNull: false,
      },

      // polymorphic link (order/payment/etc)
      ref_table: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      ref_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },
      ref_no: {
        type: DataTypes.STRING(80),
        allowNull: true,
      },

      debit: {
        // debit => payable increases
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },

      credit: {
        // credit => payable decreases
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },

      narration: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
    },
    {
      tableName: "supplier_ledger_txns",
      timestamps: true,
      indexes: [
        { fields: ["supplier_id", "txn_date"] },
        { fields: ["supplier_id", "txn_type"] },
        { fields: ["ref_table", "ref_id"] },

        // ✅ IMPORTANT: prevents double posting per order (idempotent receive save)
        {
          unique: true,
          name: "uniq_supplier_ledger_ref",
          fields: ["supplier_id", "txn_type", "ref_table", "ref_id"],
        },
      ],
    }
  );

  SupplierLedgerTxn.associate = (models) => {
    SupplierLedgerTxn.belongsTo(models.Supplier, {
      foreignKey: "supplier_id",
      as: "supplier",
    });

    // Optional: If later you create SupplierPayment model, you can add:
    // SupplierLedgerTxn.belongsTo(models.SupplierPayment, {
    //   foreignKey: "ref_id",
    //   targetKey: "id",
    //   as: "paymentRef",
    //   constraints: false,
    // });
  };

  return SupplierLedgerTxn;
};
