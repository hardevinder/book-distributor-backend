// src/routes/stockRoutes.js
const stockController = require("../controllers/stockController");

async function stockRoutes(fastify, opts) {
  // Final URL = /api/stock/summary  (prefix + "/summary")
  fastify.get("/summary", stockController.getStockSummary);
}

module.exports = stockRoutes;
