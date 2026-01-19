"use strict";

const supplierReceiptAllocationController = require(
  "../controllers/supplierReceiptAllocationController"
);

module.exports = async function supplierReceiptAllocationsRoutes(fastify) {
  /* =====================================
   * RECEIPT-WISE ALLOCATIONS
   * (keep STATIC before :id if any)
   * ===================================== */

  // 🔹 Get allocations for a receipt
  fastify.get(
    "/supplier-receipts/:id/allocations",
    supplierReceiptAllocationController.listByReceipt
  );

  // 🔹 Create / Replace allocations for a receipt
  fastify.post(
    "/supplier-receipts/:id/allocations",
    supplierReceiptAllocationController.saveForReceipt
  );

  /* =====================================
   * SCHOOL-WISE / REPORTING
   * ===================================== */

  // 🔹 School-wise / book-wise distribution report
  fastify.get(
    "/supplier-receipt-allocations",
    supplierReceiptAllocationController.listSchoolWise
  );
};
