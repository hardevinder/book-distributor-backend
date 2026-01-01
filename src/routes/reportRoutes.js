"use strict";

const report = require("../controllers/reportController");

module.exports = async function reportRoutes(fastify) {
  // If you want auth, uncomment next line
  // fastify.get("/school-supplier-billing", { preValidation: [fastify.authenticate] }, report.schoolSupplierBilling);

  fastify.get("/school-supplier-billing", report.schoolSupplierBilling);
};
