// src/routes/transportRoutes.js

const transportController = require("../controllers/transportController");

module.exports = async function (fastify, opts) {
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
