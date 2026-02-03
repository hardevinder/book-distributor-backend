// src/routes/classRoutes.js
"use strict";

const classController = require("../controllers/classController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

module.exports = async function (fastify, opts) {
  // 🔐 JWT auth for all routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔓 READ access
  const READ = { preHandler: [requireRoles("superadmin", "distributor")] };

  // 🔒 WRITE access
  const WRITE = { preHandler: [requireRoles(...SUPERADMIN_ONLY)] };

  // ===============================
  // WRITE (SUPERADMIN ONLY)
  // ===============================

  // IMPORT (Excel)
  fastify.post("/import", WRITE, classController.importClasses);

  // CREATE
  fastify.post("/", WRITE, classController.createClass);

  // UPDATE
  fastify.put("/:id", WRITE, classController.updateClass);

  // DELETE
  fastify.delete("/:id", WRITE, classController.deleteClass);

  // ===============================
  // READ (SUPERADMIN + DISTRIBUTOR)
  // ===============================

  // EXPORT (Excel)
  fastify.get("/export", READ, classController.exportClasses);

  // GET ALL
  fastify.get("/", READ, classController.getClasses);

  // GET SINGLE
  fastify.get("/:id", READ, classController.getClassById);
};
