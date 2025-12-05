// src/routes/schoolRoutes.js
const schoolController = require("../controllers/schoolController");

module.exports = async function (fastify, opts) {

  // IMPORT (Excel)
  fastify.post("/import", schoolController.importSchools);

  // EXPORT (Excel)
  fastify.get("/export", schoolController.exportSchools);

  // CREATE
  fastify.post("/", schoolController.createSchool);

  // GET ALL
  fastify.get("/", schoolController.getSchools);

  // GET SINGLE
  fastify.get("/:id", schoolController.getSchoolById);

  // UPDATE
  fastify.put("/:id", schoolController.updateSchool);

  // DELETE
  fastify.delete("/:id", schoolController.deleteSchool);
};
