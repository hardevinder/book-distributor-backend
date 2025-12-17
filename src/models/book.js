// src/models/book.js
module.exports = (sequelize, DataTypes) => {
  const Book = sequelize.define(
    "Book",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      title: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },

      publisher_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      // ✅ Book -> Supplier (catalogue / ordering)
      supplier_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true, // allow null for old data / not mapped books
      },

      code: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },

      isbn: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },

      class_name: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },

      subject: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },

      edition: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },

      mrp: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
      },

      discount_percent: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: true,
      },

      // ✅ Unit price / Rate (Per Nos)
      rate: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
      },

      // optional legacy / your internal usage
      selling_price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
      },

      medium: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },

      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      tableName: "books",
      timestamps: true,
      // indexes: [
      //   { fields: ["publisher_id"] },
      //   { fields: ["supplier_id"] },
      //   { fields: ["class_name"] },
      // ],
    }
  );

  Book.associate = (models) => {
    // Book -> Publisher
    Book.belongsTo(models.Publisher, {
      foreignKey: "publisher_id",
      as: "publisher",
    });

    // ✅ Book -> Supplier
    Book.belongsTo(models.Supplier, {
      foreignKey: "supplier_id",
      as: "supplier",
    });
  };

  return Book;
};
