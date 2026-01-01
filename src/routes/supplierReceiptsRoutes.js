"use strict";

const supplierReceiptController = require("../controllers/supplierReceiptController");

module.exports = async function supplierReceiptsRoutes(fastify) {
  /* ===============================
   * CREATE & LIST
   * =============================== */
  fastify.post("/", supplierReceiptController.create);
  fastify.get("/", supplierReceiptController.list);

  /* ===============================
   * PDF (STATIC route — MUST be before :id)
   * =============================== */
  fastify.get("/:id/pdf", supplierReceiptController.printReceiptPdf);

  /* ===============================
   * UPDATE RECEIPT FIELDS (doc_no/doc_date etc.)
   * =============================== */
  fastify.patch("/:id", supplierReceiptController.update);

  /* ===============================
   * STATUS UPDATE
   * =============================== */
  fastify.patch("/:id/status", supplierReceiptController.updateStatus);

  /* ===============================
   * GET BY ID (keep LAST)
   * =============================== */
  fastify.get("/:id", supplierReceiptController.getById);
};
