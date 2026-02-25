module.exports = (sequelize, DataTypes) => {
  const SchoolSale = sequelize.define(
    "SchoolSale",
    {
      id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },

      sale_no: { type: DataTypes.STRING(30), allowNull: false, unique: true },
      sale_date: { type: DataTypes.DATEONLY, allowNull: false },

      school_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },

      academic_session: { type: DataTypes.STRING(20), allowNull: true },
      class_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      supplier_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

      invoice_group_by: {
        type: DataTypes.ENUM("NONE", "CLASS", "PUBLISHER"),
        allowNull: false,
        defaultValue: "NONE",
      },

      status: {
        type: DataTypes.ENUM("COMPLETED", "CANCELLED"),
        allowNull: false,
        defaultValue: "COMPLETED",
      },

      subtotal: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      discount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      tax: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      total_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },

      payment_mode: {
        type: DataTypes.ENUM("CASH", "UPI", "CARD", "CREDIT", "MIXED"),
        allowNull: false,
        defaultValue: "CASH",
      },
      paid_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      balance_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },

      po_no: { type: DataTypes.STRING(50), allowNull: true },
      challan_no: { type: DataTypes.STRING(50), allowNull: true },
      due_date: { type: DataTypes.DATEONLY, allowNull: true },

      notes: { type: DataTypes.TEXT, allowNull: true },

      created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      cancelled_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      cancelled_at: { type: DataTypes.DATE, allowNull: true },
    },
    {
      tableName: "school_sales",
      timestamps: true,
      indexes: [{ fields: ["school_id"] }, { fields: ["sale_date"] }, { fields: ["academic_session"] }],
    }
  );

  SchoolSale.associate = (models) => {
    SchoolSale.belongsTo(models.School, { foreignKey: "school_id", as: "school" });
    SchoolSale.belongsTo(models.Class, { foreignKey: "class_id", as: "class" });
    if (models.Supplier) SchoolSale.belongsTo(models.Supplier, { foreignKey: "supplier_id", as: "supplier" });

    SchoolSale.hasMany(models.SchoolSaleItem, { foreignKey: "school_sale_id", as: "items" });
  };

  return SchoolSale;
};