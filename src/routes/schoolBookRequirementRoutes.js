// src/routes/schoolBookRequirementRoutes.js
"use strict";

const requirementController = require("../controllers/schoolBookRequirementController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

module.exports = async function (fastify, opts) {
  // 🔐 JWT auth for all requirement routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔒 SUPERADMIN only
  fastify.addHook("preHandler", requireRoles(...SUPERADMIN_ONLY));

  // ======================================================
  // ✅ STATIC ROUTES FIRST (avoid conflict with /:id)
  // ======================================================

  // IMPORT (Excel)
  fastify.post("/import", requirementController.importRequirements);

  // EXPORT (Excel)
  fastify.get("/export", requirementController.exportRequirements);

  // PRINT (PDF)
  fastify.get("/print-pdf", requirementController.printRequirementsPdf);

  // ✅ BULK: set status for filtered school (draft <-> confirmed)
  // POST /api/requirements/set-status
  fastify.post("/set-status", requirementController.setStatusForSchoolFiltered);

  // ======================================================
  // CRUD
  // ======================================================

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
