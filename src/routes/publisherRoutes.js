// src/routes/publisherRoutes.js
"use strict";

const publisherController = require("../controllers/publisherController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

module.exports = async function (fastify, opts) {
  // 🔐 JWT auth for all publisher routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔒 SUPERADMIN only
  fastify.addHook("preHandler", requireRoles(...SUPERADMIN_ONLY));

  // 🔥 BULK IMPORT (Excel Upload)
  fastify.post("/import", publisherController.importPublishers);

  // 🔥 BULK EXPORT (Excel Download)
  fastify.get("/export", publisherController.exportPublishers);

  // CREATE
  fastify.post("/", publisherController.createPublisher);

  // READ ALL
  fastify.get("/", publisherController.getPublishers);

  // READ SINGLE
  fastify.get("/:id", publisherController.getPublisherById);

  // UPDATE
  fastify.put("/:id", publisherController.updatePublisher);

  // SOFT DELETE
  fastify.delete("/:id", publisherController.deletePublisher);
};
