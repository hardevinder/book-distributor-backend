// src/models/schoolOrderEmailLog.js
"use strict";

module.exports = (sequelize, DataTypes) => {
  const SchoolOrderEmailLog = sequelize.define(
    "SchoolOrderEmailLog",
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },

      school_order_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
      },

      sent_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },

      to_email: {
        type: DataTypes.STRING(500),
        allowNull: false,
      },

      cc_email: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },

      subject: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },

      body_text: {
        type: DataTypes.TEXT,
        allowNull: true,
      },

      status: {
        type: DataTypes.ENUM("SENT", "FAILED"),
        allowNull: false,
        defaultValue: "SENT",
      },

      error: {
        type: DataTypes.TEXT,
        allowNull: true,
      },

      sent_by_user_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },

      message_id: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
    },
    {
      tableName: "school_order_email_logs",
      timestamps: false,
      indexes: [
        { fields: ["school_order_id"] },
        { fields: ["sent_at"] },
        { fields: ["status"] },
      ],
    }
  );

  SchoolOrderEmailLog.associate = (models) => {
    SchoolOrderEmailLog.belongsTo(models.SchoolOrder, {
      foreignKey: "school_order_id",
      as: "order",
    });

    // Optional: if you have Users table/model
    // if (models.User) {
    //   SchoolOrderEmailLog.belongsTo(models.User, { foreignKey: "sent_by_user_id", as: "sentBy" });
    // }
  };

  return SchoolOrderEmailLog;
};
