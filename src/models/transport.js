// src/models/transport.js

module.exports = (sequelize, DataTypes) => {
  const Transport = sequelize.define(
    "Transport",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      // Main name of the transport company
      name: {
        type: DataTypes.STRING(150),
        allowNull: false,
      },

      // Optional contact person
      contact_person: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },

      // Phone / mobile number
      phone: {
        type: DataTypes.STRING(30),
        allowNull: true,
      },

      // Optional email id
      email: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },

      // Full address
      address: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },

      city: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },

      state: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },

      pincode: {
        type: DataTypes.STRING(10),
        allowNull: true,
      },

      // Any extra note like “Delhi Meerut Cargo Darya Ganj New Delhi”
      remarks: {
        type: DataTypes.TEXT,
        allowNull: true,
      },

      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      tableName: "transports",
      timestamps: true,
    }
  );

  return Transport;
};
