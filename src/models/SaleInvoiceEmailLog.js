"use strict";

module.exports = (sequelize, DataTypes) => {
  const SaleInvoiceEmailLog = sequelize.define(
    "SaleInvoiceEmailLog",
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },

      sale_invoice_id: { type: DataTypes.INTEGER, allowNull: false },

      to_email: { type: DataTypes.TEXT, allowNull: true },
      cc_email: { type: DataTypes.TEXT, allowNull: true },
      subject: { type: DataTypes.TEXT, allowNull: true },

      message_id: { type: DataTypes.STRING(255), allowNull: true },
      group_id: { type: DataTypes.STRING(255), allowNull: true },

      recipient_type: {
        type: DataTypes.ENUM("to", "cc", "unknown"),
        allowNull: false,
        defaultValue: "unknown",
      },

      status: {
        type: DataTypes.ENUM("SENT", "FAILED"),
        allowNull: false,
        defaultValue: "SENT",
      },

      sent_at: { type: DataTypes.DATE, allowNull: true },
      error_message: { type: DataTypes.TEXT, allowNull: true },
      meta: { type: DataTypes.JSON, allowNull: true },
    },
    { tableName: "sale_invoice_email_logs", underscored: true }
  );

  SaleInvoiceEmailLog.associate = (models) => {
    SaleInvoiceEmailLog.belongsTo(models.SaleInvoice, {
      foreignKey: "sale_invoice_id",
      as: "invoice",
    });
  };

  return SaleInvoiceEmailLog;
};