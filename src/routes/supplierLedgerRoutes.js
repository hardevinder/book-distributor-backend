// src/routes/supplierLedgerRoutes.js
"use strict";

const supplierLedgerController = require("../controllers/supplierLedgerController");

module.exports = async function supplierLedgerRoutes(fastify, opts) {
  // 🔐 Protect all supplier-ledger routes with JWT (recommended)
  fastify.addHook("onRequest", fastify.authenticate);

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
   * Query params:
   *   - from=YYYY-MM-DD
   *   - to=YYYY-MM-DD
   *   - limit=number (default 200, max 500)
   *
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
   *
   * POST /api/suppliers/:supplierId/payments
   * → Creates credit entry (SupplierPayment + Ledger credit)
   *
   * GET  /api/suppliers/:supplierId/payments
   * → List payments
   *
   * We will add these after SupplierPayment controller
   */
};
