// src/routes/schoolRoutes.js
"use strict";

const schoolController = require("../controllers/schoolController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

module.exports = async function (fastify, opts) {
  // 🔐 JWT auth for all school routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔓 READ access
  const READ = { preHandler: [requireRoles("superadmin", "distributor")] };

  // 🔒 WRITE access
  const WRITE = { preHandler: [requireRoles(...SUPERADMIN_ONLY)] };

  // ===============================
  // WRITE (SUPERADMIN ONLY)
  // ===============================

  // IMPORT (Excel)
  fastify.post("/import", WRITE, schoolController.importSchools);

  // CREATE
  fastify.post("/", WRITE, schoolController.createSchool);

  // UPDATE
  fastify.put("/:id", WRITE, schoolController.updateSchool);

  // DELETE
  fastify.delete("/:id", WRITE, schoolController.deleteSchool);

  // ===============================
  // READ (SUPERADMIN + DISTRIBUTOR)
  // ===============================

  // EXPORT (Excel)
  fastify.get("/export", READ, schoolController.exportSchools);

  // GET ALL
  fastify.get("/", READ, schoolController.getSchools);

  // GET SINGLE
  fastify.get("/:id", READ, schoolController.getSchoolById);
};
