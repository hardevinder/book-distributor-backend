"use strict";

const saleController = require("../controllers/saleController");

/**
 * Sales Routes
 * Base usually mounted at: /api/sales
 *
 * Endpoints:
 *  POST   /api/sales              -> create sale
 *  GET    /api/sales              -> list sales
 *  GET    /api/sales/:id          -> get sale
 *  GET    /api/sales/:id/receipt  -> receipt PDF (size=a5|3in)
 *  POST   /api/sales/:id/cancel   -> cancel sale (revert stock)
 */
module.exports = async function saleRoutes(fastify) {
  const auth = fastify.authenticate ? [fastify.authenticate] : [];

  // ✅ Create
  fastify.post("/", { preHandler: auth }, saleController.create);

  // ✅ List
  fastify.get("/", { preHandler: auth }, saleController.list);

  // ✅ Receipt PDF (keep before :id route is NOT required, but safe)
  fastify.get("/:id/receipt", { preHandler: auth }, saleController.receiptPdf);

  // ✅ Cancel
  fastify.post("/:id/cancel", { preHandler: auth }, saleController.cancel);

  // ✅ Get One (param route should be last)
  fastify.get("/:id", { preHandler: auth }, saleController.getOne);
};
