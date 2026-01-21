"use strict";

module.exports = (sequelize, DataTypes) => {
  const SupplierReceiptAllocation = sequelize.define(
    "SupplierReceiptAllocation",
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

      school_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      book_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      qty: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },

      is_specimen: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },

      specimen_reason: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },

      // ✅ NEW: pricing fields (optional for specimen, we will store 0)
      rate: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: 0,
      },

      disc_pct: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: 0,
      },

      disc_amt: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: 0,
      },

      amount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true,
        defaultValue: 0,
      },

      remarks: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },

      issued_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        defaultValue: sequelize.literal("CURRENT_DATE"),
      },
    },
    {
      tableName: "supplier_receipt_allocations",
      timestamps: true,

      // ✅ IMPORTANT: Use SHORT index names (MySQL 64-char limit)
      indexes: [
        { name: "idx_sra_receipt", fields: ["supplier_receipt_id"] },
        { name: "idx_sra_school_date", fields: ["school_id", "issued_date"] },
        { name: "idx_sra_book", fields: ["book_id"] },

        // ✅ Composite for validation/summing remaining
        {
          name: "idx_sra_receipt_book_spec",
          fields: ["supplier_receipt_id", "book_id", "is_specimen"],
        },

        // ✅ Helpful for reports / school-book drilldown
        {
          name: "idx_sra_school_book_date",
          fields: ["school_id", "book_id", "issued_date"],
        },

        // ✅ OPTIONAL: enforce one row per receipt+school+book+specimen (if you want strict uniqueness)
        // {
        //   name: "uq_sra_receipt_school_book_spec",
        //   unique: true,
        //   fields: ["supplier_receipt_id", "school_id", "book_id", "is_specimen"],
        // },
      ],
    }
  );

  // ✅ auto-clean pricing for specimen before validate/save (extra safety)
  SupplierReceiptAllocation.addHook("beforeValidate", (row) => {
    const isSpec = row.is_specimen === true || row.is_specimen === 1 || row.is_specimen === "1";
    if (isSpec) {
      row.rate = 0;
      row.disc_pct = 0;
      row.disc_amt = 0;
      row.amount = 0;
    } else {
      // normalize nulls
      row.rate = row.rate == null ? 0 : row.rate;
      row.disc_pct = row.disc_pct == null ? 0 : row.disc_pct;
      row.disc_amt = row.disc_amt == null ? 0 : row.disc_amt;
      row.amount = row.amount == null ? 0 : row.amount;
    }
  });

  SupplierReceiptAllocation.associate = (models) => {
    // receipt
    if (models.SupplierReceipt) {
      SupplierReceiptAllocation.belongsTo(models.SupplierReceipt, {
        foreignKey: "supplier_receipt_id",
        as: "receipt",
      });
    }

    // school
    if (models.School) {
      SupplierReceiptAllocation.belongsTo(models.School, {
        foreignKey: "school_id",
        as: "school",
      });
    }

    // book
    if (models.Book) {
      SupplierReceiptAllocation.belongsTo(models.Book, {
        foreignKey: "book_id",
        as: "book",
      });
    }
  };

  return SupplierReceiptAllocation;
};
