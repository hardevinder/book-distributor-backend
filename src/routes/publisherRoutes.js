// src/routes/publisherRoutes.js

const publisherController = require("../controllers/publisherController");

module.exports = async function (fastify, opts) {
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
