"use strict";

module.exports = (sequelize, DataTypes) => {
  const DistributorSchool = sequelize.define(
    "DistributorSchool",
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      distributor_id: { type: DataTypes.INTEGER, allowNull: false },
      school_id: { type: DataTypes.INTEGER, allowNull: false },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    {
      tableName: "distributor_schools",
      underscored: true,
      timestamps: true,
      indexes: [
        { unique: true, fields: ["distributor_id", "school_id"] },
        { fields: ["school_id"] },
      ],
    }
  );

  DistributorSchool.associate = (models) => {
    DistributorSchool.belongsTo(models.User, { foreignKey: "distributor_id", as: "distributor" });
    DistributorSchool.belongsTo(models.School, { foreignKey: "school_id", as: "school" });
  };

  return DistributorSchool;
};
