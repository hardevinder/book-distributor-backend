// src/routes/schoolRoutes.js
"use strict";

const schoolController = require("../controllers/schoolController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

module.exports = async function (fastify) {
  /**
   * ⚠️ ORDER MATTERS
   * Static routes BEFORE param routes (/:id)
   */

  // 🔐 JWT auth for all school routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔓 READ access (Superadmin + Distributor)
  // NOTE: requireRoles usually expects role names in same format as stored in JWT (often lowercase)
  const READ = { preHandler: [requireRoles("superadmin", "distributor")] };

  // 🔒 WRITE access (Superadmin only)
  const WRITE = { preHandler: [requireRoles(...SUPERADMIN_ONLY)] };

  // ===============================
  // READ (SUPERADMIN + DISTRIBUTOR)
  // ===============================

  // ✅ My schools (best for distributor dropdown)
  // GET /api/schools/my/schools
  fastify.get("/my/schools", READ, schoolController.getMySchools);

  // EXPORT (Excel)
  // GET /api/schools/export
  fastify.get("/export", READ, schoolController.exportSchools);

  // GET ALL (restricted in controller for distributor)
  // GET /api/schools
  fastify.get("/", READ, schoolController.getSchools);

  // ===============================
  // WRITE (SUPERADMIN ONLY)
  // ===============================

  // IMPORT (Excel)
  // POST /api/schools/import
  fastify.post("/import", WRITE, schoolController.importSchools);

  // CREATE
  // POST /api/schools
  fastify.post("/", WRITE, schoolController.createSchool);

  // UPDATE
  // PUT /api/schools/:id
  fastify.put("/:id", WRITE, schoolController.updateSchool);

  // DELETE
  // DELETE /api/schools/:id
  fastify.delete("/:id", WRITE, schoolController.deleteSchool);

  // ===============================
  // READ SINGLE (STATIC ROUTES ABOVE THIS)
  // ===============================

  // GET SINGLE (restricted in controller for distributor)
  // GET /api/schools/:id
  fastify.get("/:id", READ, schoolController.getSchoolById);
};
