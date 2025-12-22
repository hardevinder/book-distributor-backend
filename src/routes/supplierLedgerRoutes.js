"use strict";

const supplierLedgerController = require("../controllers/supplierLedgerController");

module.exports = async function supplierLedgerRoutes(fastify) {
  // If you want auth:
  // const auth = { preHandler: [fastify.authenticate] };

  fastify.get("/:supplierId/balance", supplierLedgerController.balance);
  fastify.get("/:supplierId/ledger", supplierLedgerController.ledger);
};
