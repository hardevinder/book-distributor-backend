// src/routes/supplierReceiptsRoutes.js
"use strict";

const supplierReceiptController = require("../controllers/supplierReceiptController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

module.exports = async function supplierReceiptsRoutes(fastify) {
  // 🔐 JWT auth for all supplier-receipt routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔒 SUPERADMIN only
  fastify.addHook("preHandler", requireRoles(...SUPERADMIN_ONLY));

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
   * STATUS UPDATE (keep before :id)
   * =============================== */
  fastify.patch("/:id/status", supplierReceiptController.updateStatus);

  /* ===============================
   * UPDATE RECEIPT FIELDS (doc_no/doc_date etc.)
   * =============================== */
  fastify.patch("/:id", supplierReceiptController.update);

  /* ===============================
   * ✅ DELETE RECEIPT (only DRAFT + not posted)
   * =============================== */
  fastify.delete("/:id", supplierReceiptController.remove);

  /* ===============================
   * GET BY ID (keep LAST)
   * =============================== */
  fastify.get("/:id", supplierReceiptController.getById);
};
