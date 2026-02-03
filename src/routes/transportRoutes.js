// src/routes/transportRoutes.js
"use strict";

const transportController = require("../controllers/transportController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

module.exports = async function (fastify, opts) {
  // 🔐 JWT auth for all transport routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔒 SUPERADMIN only
  fastify.addHook("preHandler", requireRoles(...SUPERADMIN_ONLY));

  // 🔥 BULK IMPORT (Excel Upload)
  fastify.post("/import", transportController.importTransports);

  // 🔥 BULK EXPORT (Excel Download)
  fastify.get("/export", transportController.exportTransports);

  // CREATE
  fastify.post("/", transportController.createTransport);

  // READ ALL
  fastify.get("/", transportController.getTransports);

  // READ SINGLE
  fastify.get("/:id", transportController.getTransportById);

  // UPDATE
  fastify.put("/:id", transportController.updateTransport);

  // DELETE
  fastify.delete("/:id", transportController.deleteTransport);
};
