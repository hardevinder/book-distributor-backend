// src/routes/supplierLedgerRoutes.js
"use strict";

const supplierLedgerController = require("../controllers/supplierLedgerController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

module.exports = async function supplierLedgerRoutes(fastify, opts) {
  // 🔐 JWT auth for all supplier-ledger routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔒 SUPERADMIN only
  fastify.addHook("preHandler", requireRoles(...SUPERADMIN_ONLY));

  /**
   * ============================
   * Supplier Ledger / Balance
   * ============================
   */

  /**
   * GET /api/suppliers/:supplierId/balance
   * → Current payable balance for supplier
   */
  fastify.get(
    "/:supplierId/balance",
    supplierLedgerController.balance
  );

  /**
   * GET /api/suppliers/:supplierId/ledger
   * → Ledger with running balance
   */
  fastify.get(
    "/:supplierId/ledger",
    supplierLedgerController.ledger
  );

  /**
   * ============================
   * (NEXT STEP – NOT YET ADDED)
   * ============================
   * Payments routes will also inherit SUPERADMIN-only
   */
};
