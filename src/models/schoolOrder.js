// src/models/schoolOrder.js

module.exports = (sequelize, DataTypes) => {
  const SchoolOrder = sequelize.define(
    "SchoolOrder",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      school_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      // ✅ NEW: supplier-wise order
      supplier_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false, // one order must belong to one supplier
      },

      order_no: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: true,
      },

      academic_session: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },

      order_date: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },

      status: {
        type: DataTypes.ENUM(
          "draft",
          "sent",
          "partial_received",
          "completed",
          "cancelled"
        ),
        allowNull: false,
        defaultValue: "draft",
      },

      remarks: {
        type: DataTypes.TEXT,
        allowNull: true,
      },

      // FK → transports.id (Option 1)
      transport_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      // “Through” text (Option 1)
      transport_through: {
        type: DataTypes.STRING(150),
        allowNull: true,
      },

      // ✅ NEW: Option 2 transport
      transport_id_2: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      // ✅ NEW: “Through” text (Option 2)
      transport_through_2: {
        type: DataTypes.STRING(150),
        allowNull: true,
      },

      // Notes (will be printed highlighted in footer)
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      tableName: "school_orders",
      timestamps: true,
    }
  );

  SchoolOrder.associate = (models) => {
    SchoolOrder.belongsTo(models.School, {
      foreignKey: "school_id",
      as: "school",
    });

    // ✅ supplier master
    SchoolOrder.belongsTo(models.Supplier, {
      foreignKey: "supplier_id",
      as: "supplier",
    });

    // ✅ Option 1 transport
    SchoolOrder.belongsTo(models.Transport, {
      foreignKey: "transport_id",
      as: "transport", // (controller uses as: "transport")
    });

    // ✅ Option 2 transport
    SchoolOrder.belongsTo(models.Transport, {
      foreignKey: "transport_id_2",
      as: "transport2",
    });

    SchoolOrder.hasMany(models.SchoolOrderItem, {
      foreignKey: "school_order_id",
      as: "items",
    });
  };

  return SchoolOrder;
};
