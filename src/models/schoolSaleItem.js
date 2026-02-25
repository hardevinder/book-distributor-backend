module.exports = (sequelize, DataTypes) => {
  const SchoolSaleItem = sequelize.define(
    "SchoolSaleItem",
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      school_sale_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },

      // link to requirement row (school_book_requirements.id)
      requirement_item_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

      product_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      book_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

      kind: { type: DataTypes.ENUM("BOOK", "MATERIAL"), allowNull: false, defaultValue: "BOOK" },

      title_snapshot: { type: DataTypes.STRING(255), allowNull: true },
      class_name_snapshot: { type: DataTypes.STRING(50), allowNull: true },
      publisher_snapshot: { type: DataTypes.STRING(255), allowNull: true },

      requested_qty: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      requested_unit_price: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },

      issued_qty: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      short_qty: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    },
    {
      tableName: "school_sale_items",
      timestamps: true,
      indexes: [{ fields: ["school_sale_id"] }, { fields: ["book_id"] }, { fields: ["requirement_item_id"] }],
    }
  );

  SchoolSaleItem.associate = (models) => {
    SchoolSaleItem.belongsTo(models.SchoolSale, { foreignKey: "school_sale_id", as: "sale" });
    SchoolSaleItem.belongsTo(models.Book, { foreignKey: "book_id", as: "book" });
    SchoolSaleItem.belongsTo(models.Product, { foreignKey: "product_id", as: "product" });

    SchoolSaleItem.belongsTo(models.SchoolBookRequirement, {
      foreignKey: "requirement_item_id",
      as: "requirement_row",
    });
  };

  return SchoolSaleItem;
};