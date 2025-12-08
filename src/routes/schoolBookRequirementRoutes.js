// src/routes/schoolBookRequirementRoutes.js
const requirementController = require("../controllers/schoolBookRequirementController");

module.exports = async function (fastify, opts) {
  // IMPORT (Excel)
  fastify.post("/import", requirementController.importRequirements);

  // EXPORT (Excel)
  fastify.get("/export", requirementController.exportRequirements);

  // PRINT (PDF)
  fastify.get("/print-pdf", requirementController.printRequirementsPdf);

  // CREATE (single / upsert)
  fastify.post("/", requirementController.createRequirement);

  // GET ALL (with filters, latest on top)
  fastify.get("/", requirementController.getRequirements);

  // GET SINGLE
  fastify.get("/:id", requirementController.getRequirementById);

  // UPDATE
  fastify.put("/:id", requirementController.updateRequirement);

  // DELETE
  fastify.delete("/:id", requirementController.deleteRequirement);
};
