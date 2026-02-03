"use strict";

const supplierPaymentController = require("../controllers/supplierPaymentController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

module.exports = async function supplierPaymentRoutes(fastify, opts) {
  // 🔐 JWT auth for all supplier-payment routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔒 SUPERADMIN only
  fastify.addHook("preHandler", requireRoles(...SUPERADMIN_ONLY));

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
   * → Get single payment
   */
  fastify.get(
    "/:supplierId/payments/:paymentId",
    supplierPaymentController.getPaymentById
  );

  /**
   * DELETE /api/suppliers/:supplierId/payments/:paymentId
   * → Delete payment
   */
  fastify.delete(
    "/:supplierId/payments/:paymentId",
    supplierPaymentController.deletePayment
  );

  /**
   * DELETE /api/suppliers/payments/:paymentId
   * → Backward compatibility
   */
  fastify.delete(
    "/payments/:paymentId",
    supplierPaymentController.deletePayment
  );
};
