// routes/supplierReceiptAllocationsRoutes.js
"use strict";

const supplierReceiptAllocationController = require(
  "../controllers/supplierReceiptAllocationController"
);
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

module.exports = async function supplierReceiptAllocationsRoutes(fastify) {
  // 🔐 JWT auth for all allocation routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔒 SUPERADMIN only
  fastify.addHook("preHandler", requireRoles(...SUPERADMIN_ONLY));

  /* ============================================================
   * SCHOOL-WISE / REPORTING (STATIC FIRST ✅)
   * ============================================================ */

  // GET /api/supplier-receipt-allocations
  fastify.get(
    "/supplier-receipt-allocations",
    supplierReceiptAllocationController.listSchoolWise
  );

  /* ============================================================
   * RECEIPT-WISE ALLOCATIONS
   * ============================================================ */

  // GET /api/supplier-receipts/:id/allocations
  fastify.get(
    "/supplier-receipts/:id/allocations",
    supplierReceiptAllocationController.listByReceipt
  );

  // POST /api/supplier-receipts/:id/allocations
  // body: { mode: "APPEND"|"REPLACE", allocations: [...] }
  fastify.post(
    "/supplier-receipts/:id/allocations",
    supplierReceiptAllocationController.saveForReceipt
  );
};
