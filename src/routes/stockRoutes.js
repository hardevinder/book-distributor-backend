// src/routes/stockRoutes.js
"use strict";

const stockController = require("../controllers/stockController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

async function stockRoutes(fastify, opts) {
  // 🔐 JWT auth for all stock routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔒 SUPERADMIN only
  fastify.addHook("preHandler", requireRoles(...SUPERADMIN_ONLY));

  // Final URL = /api/stock/summary
  fastify.get("/summary", stockController.getStockSummary);
}

module.exports = stockRoutes;
