"use strict";

const reportController = require("../controllers/reportController");

module.exports = async function reportRoutes(fastify) {
  /**
   * ===============================
   * SCHOOL → SUPPLIER → BILLING
   * ===============================
   * Receipt-driven + Order baseline report.
   *
   * Returns:
   *  - Ordered / Received / Pending Qty
   *  - Supplier-wise + Class-wise breakup
   *  - Amounts: orderedNet / receivedNet / pendingNet
   *
   * Query Params:
   *  - schoolId (required)
   *  - academic_session (optional)
   *  - supplierId (optional)
   *  - from (YYYY-MM-DD)
   *  - to (YYYY-MM-DD)
   *  - includeDraft=true (optional)
   *  - view=ALL | RECEIVED | PENDING (optional)
   */
  fastify.get(
    "/school-supplier-billing",
    // { preValidation: [fastify.authenticate] }, // 🔐 enable when needed
    reportController.schoolSupplierBilling
  );

  /**
   * ===============================
   * (FUTURE-READY) RECEIPT / GRN REPORTS
   * ===============================
   * Reserved routes (enable when controller exists).
   */

  // fastify.get(
  //   "/school-supplier-receipts",
  //   { preValidation: [fastify.authenticate] },
  //   reportController.schoolSupplierReceipts
  // );

  // fastify.get(
  //   "/supplier-ledger-summary",
  //   { preValidation: [fastify.authenticate] },
  //   reportController.supplierLedgerSummary
  // );
};
