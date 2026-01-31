"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    // Add distributor_id column to users table
    await queryInterface.addColumn("users", "distributor_id", {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
      references: {
        model: "distributors",
        key: "id",
      },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    });

    // Index for faster lookups
    await queryInterface.addIndex("users", ["distributor_id"]);
  },

  async down(queryInterface) {
    // Remove index first
    await queryInterface.removeIndex("users", ["distributor_id"]);

    // Remove column
    await queryInterface.removeColumn("users", "distributor_id");
  },
};
