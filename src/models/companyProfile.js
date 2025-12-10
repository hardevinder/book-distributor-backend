// src/models/companyProfile.js
module.exports = (sequelize, DataTypes) => {
  const CompanyProfile = sequelize.define(
    "CompanyProfile",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
      },

      name: {
        type: DataTypes.STRING(150),
        allowNull: false,
      },

      address_line1: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      address_line2: {
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
        type: DataTypes.STRING(20),
        allowNull: true,
      },

      phone_primary: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      phone_secondary: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      email: {
        type: DataTypes.STRING(150),
        allowNull: true,
      },
      website: {
        type: DataTypes.STRING(150),
        allowNull: true,
      },

      gstin: {
        type: DataTypes.STRING(30),
        allowNull: true,
      },

      // store uploaded logo path or URL (e.g. /uploads/logos/xyz.png)
      logo_url: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },

      is_default: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },

      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      tableName: "company_profiles",
      underscored: true,
    }
  );

  CompanyProfile.associate = (models) => {
    // no direct associations for now
  };

  return CompanyProfile;
};
