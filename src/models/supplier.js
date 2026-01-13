"use strict";

module.exports = (sequelize, DataTypes) => {
  const Supplier = sequelize.define(
    "Supplier",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      name: {
        type: DataTypes.STRING(150),
        allowNull: false,
      },

      contact_person: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },

      phone: {
        type: DataTypes.STRING(30),
        allowNull: true,
      },

      email: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },

      address: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },

      // ✅ Supplier → Publisher
      publisher_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      tableName: "suppliers",
      timestamps: true,
      indexes: [
        { fields: ["publisher_id"] },
        { fields: ["is_active"] },
      ],
    }
  );

  /* ============================
   * Associations
   * ============================ */
  Supplier.associate = (models) => {
    // ✅ Supplier → SupplierReceipts (IMPORTANT)
    if (models.SupplierReceipt) {
      Supplier.hasMany(models.SupplierReceipt, {
        foreignKey: "supplier_id",
        as: "receipts",
      });
    }

    // Supplier → SchoolOrders
    if (models.SchoolOrder) {
      Supplier.hasMany(models.SchoolOrder, {
        foreignKey: "supplier_id",
        as: "schoolOrders",
      });
    }

    // Supplier → Books (catalogue)
    if (models.Book) {
      Supplier.hasMany(models.Book, {
        foreignKey: "supplier_id",
        as: "books",
      });
    }

    // Supplier → Publisher
    if (models.Publisher) {
      Supplier.belongsTo(models.Publisher, {
        foreignKey: "publisher_id",
        as: "publisher",
      });
    }
  };

  return Supplier;
};
