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

      code: {
        type: DataTypes.STRING(50), // internal book code
        allowNull: true,
      },

      isbn: {
        type: DataTypes.STRING(20), // ISBN-10 / ISBN-13
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
    }
  );

  // 🔗 Relation: Book → Publisher
  Book.associate = (models) => {
    Book.belongsTo(models.Publisher, {
      foreignKey: "publisher_id",
      as: "publisher",
    });
  };

  return Book;
};
