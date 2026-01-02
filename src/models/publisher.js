// src/models/publisher.js
module.exports = (sequelize, DataTypes) => {
  const Publisher = sequelize.define(
    "Publisher",
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

      // Optional / informational only
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
      tableName: "publishers",
      timestamps: true,
      indexes: [
        // optional but useful for name lookups
        { fields: ["name"] },
      ],
    }
  );

  // ✅ Associations
  Publisher.associate = (models) => {
    // Publisher -> Suppliers (ONE publisher, MANY suppliers)
    Publisher.hasMany(models.Supplier, {
      foreignKey: "publisher_id",
      as: "suppliers",
    });

    // (Future safe)
    // Publisher.hasMany(models.Book, { foreignKey: "publisher_id", as: "books" });
  };

  return Publisher;
};
