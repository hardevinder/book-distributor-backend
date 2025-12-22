"use strict";

const supplierReceiptController = require("../controllers/supplierReceiptController");

module.exports = async function supplierReceiptsRoutes(fastify) {
  // If you want auth:
  // const auth = { preHandler: [fastify.authenticate] };

  fastify.post("/", supplierReceiptController.create);
  fastify.get("/", supplierReceiptController.list);
  fastify.patch("/:id/status", supplierReceiptController.updateStatus);
  fastify.get("/:id", supplierReceiptController.getById);
};
