// src/routes/classRoutes.js
const classController = require("../controllers/classController");

module.exports = async function (fastify, opts) {

  // IMPORT (Excel)
  fastify.post("/import", classController.importClasses);

  // EXPORT (Excel)
  fastify.get("/export", classController.exportClasses);

  // CREATE
  fastify.post("/", classController.createClass);

  // GET ALL
  fastify.get("/", classController.getClasses);

  // GET SINGLE
  fastify.get("/:id", classController.getClassById);

  // UPDATE
  fastify.put("/:id", classController.updateClass);

  // DELETE
  fastify.delete("/:id", classController.deleteClass);
};
