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
      contact_person: {
        type: DataTypes.STRING(100),
      },
      phone: {
        type: DataTypes.STRING(30),
      },
      email: {
        type: DataTypes.STRING(100),
      },
      address: {
        type: DataTypes.STRING(255),
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      }
    },
    {
      tableName: "publishers",
      timestamps: true,
    }
  );

  return Publisher;
};
