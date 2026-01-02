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

      // ✅ NEW: Supplier -> Publisher (FK)
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
        // helpful for joins
        { fields: ["publisher_id"] },
      ],
    }
  );

  // ✅ Associations
  Supplier.associate = (models) => {
    // Supplier -> SchoolOrders
    Supplier.hasMany(models.SchoolOrder, {
      foreignKey: "supplier_id",
      as: "schoolOrders",
    });

    // Supplier -> Books (Catalogue)
    Supplier.hasMany(models.Book, {
      foreignKey: "supplier_id",
      as: "books",
    });

    // ✅ Supplier -> Publisher
    Supplier.belongsTo(models.Publisher, {
      foreignKey: "publisher_id",
      as: "publisher",
    });
  };

  return Supplier;
};
