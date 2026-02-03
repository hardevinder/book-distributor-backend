"use strict";

const reportController = require("../controllers/reportController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

module.exports = async function reportRoutes(fastify) {
  // 🔐 JWT auth for all report routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔒 SUPERADMIN only
  fastify.addHook("preHandler", requireRoles(...SUPERADMIN_ONLY));

  /**
   * ===============================
   * SCHOOL → SUPPLIER → BILLING
   * ===============================
   */
  fastify.get(
    "/school-supplier-billing",
    reportController.schoolSupplierBilling
  );

  /**
   * ===============================
   * (FUTURE-READY) RECEIPT / GRN REPORTS
   * ===============================
   */

  // fastify.get("/school-supplier-receipts", reportController.schoolSupplierReceipts);
  // fastify.get("/supplier-ledger-summary", reportController.supplierLedgerSummary);
};
