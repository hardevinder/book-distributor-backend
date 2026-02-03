// src/routes/supplierRoutes.js
"use strict";

const supplierController = require("../controllers/supplierController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

async function supplierRoutes(fastify) {
  // 🔐 JWT auth for all supplier routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔒 SUPERADMIN only
  fastify.addHook("preHandler", requireRoles(...SUPERADMIN_ONLY));

  // LIST
  fastify.get("/", supplierController.list);

  // invoices
  fastify.get("/:id/invoices", supplierController.listInvoices);
  fastify.get("/:id/invoices/:invoiceId", supplierController.getInvoiceDetail);

  // GET SINGLE
  fastify.get("/:id", supplierController.getById);

  // CREATE
  fastify.post("/", supplierController.create);

  // UPDATE
  fastify.put("/:id", supplierController.update);

  // DELETE
  fastify.delete("/:id", supplierController.remove);
}

module.exports = supplierRoutes;
