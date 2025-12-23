"use strict";

const supplierPaymentController = require("../controllers/supplierPaymentController");

module.exports = async function supplierPaymentRoutes(fastify, opts) {
  // 🔐 Protect all supplier-payment routes
  fastify.addHook("onRequest", fastify.authenticate);

  /**
   * ============================
   * Supplier Payments (CREDIT)
   * ============================
   */

  /**
   * POST /api/suppliers/:supplierId/payments
   * → Create supplier payment
   * → Auto posts CREDIT entry into supplier_ledger_txns
   */
  fastify.post(
    "/:supplierId/payments",
    supplierPaymentController.createPayment
  );

  /**
   * GET /api/suppliers/:supplierId/payments
   * → List supplier payments
   */
  fastify.get(
    "/:supplierId/payments",
    supplierPaymentController.listPayments
  );

  /**
   * GET /api/suppliers/:supplierId/payments/:paymentId
   * → Get single payment (View modal)
   */
  fastify.get(
    "/:supplierId/payments/:paymentId",
    supplierPaymentController.getPaymentById
  );

  /**
   * DELETE /api/suppliers/:supplierId/payments/:paymentId
   * → Delete payment (frontend-compatible)
   */
  fastify.delete(
    "/:supplierId/payments/:paymentId",
    supplierPaymentController.deletePayment
  );

  /**
   * DELETE /api/suppliers/payments/:paymentId
   * → Backward compatibility (optional)
   */
  fastify.delete(
    "/payments/:paymentId",
    supplierPaymentController.deletePayment
  );
};
