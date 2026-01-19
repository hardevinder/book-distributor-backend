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

        // ✅ Composite index (short name)
        {
          name: "idx_sra_receipt_book_spec",
          fields: ["supplier_receipt_id", "book_id", "is_specimen"],
        },

        // ✅ OPTIONAL: enforce one row per receipt+school+book+specimen (short name)
        // {
        //   name: "uq_sra_receipt_school_book_spec",
        //   unique: true,
        //   fields: ["supplier_receipt_id", "school_id", "book_id", "is_specimen"],
        // },
      ],
    }
  );

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
