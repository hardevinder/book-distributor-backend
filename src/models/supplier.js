// src/models/supplier.js
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
        unique: true,
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

      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      tableName: "suppliers",
      timestamps: true,
    }
  );

  // ✅ Associations
  Supplier.associate = (models) => {
    // Supplier -> SchoolOrders
    Supplier.hasMany(models.SchoolOrder, {
      foreignKey: "supplier_id",
      as: "schoolOrders",
    });

    // ✅ Supplier -> Books (Catalogue)
    Supplier.hasMany(models.Book, {
      foreignKey: "supplier_id",
      as: "books",
    });

    // (Optional) if you ever link supplier on publisher:
    // Supplier.hasMany(models.Publisher, { foreignKey: "supplier_id", as: "publishers" });
  };

  return Supplier;
};
