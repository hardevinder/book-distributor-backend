// routes/supplierReceiptAllocationsRoutes.js
"use strict";

const supplierReceiptAllocationController = require(
  "../controllers/supplierReceiptAllocationController"
);

module.exports = async function supplierReceiptAllocationsRoutes(fastify) {
  /* ============================================================
   * SCHOOL-WISE / REPORTING (STATIC FIRST ✅)
   * ============================================================ */

  // 🔹 School-wise / book-wise distribution report
  // GET /api/supplier-receipt-allocations?school_id=&book_id=&from=&to=&supplier_id=&q=
  fastify.get(
    "/supplier-receipt-allocations",
    supplierReceiptAllocationController.listSchoolWise
  );

  /* ============================================================
   * RECEIPT-WISE ALLOCATIONS
   * ============================================================ */

  // 🔹 Get allocations for a receipt
  // GET /api/supplier-receipts/:id/allocations
  fastify.get(
    "/supplier-receipts/:id/allocations",
    supplierReceiptAllocationController.listByReceipt
  );

  // 🔹 Create / Replace allocations for a receipt
  // POST /api/supplier-receipts/:id/allocations
  // body: { mode: "APPEND"|"REPLACE", allocations: [...] }
  fastify.post(
    "/supplier-receipts/:id/allocations",
    supplierReceiptAllocationController.saveForReceipt
  );
};
