// src/routes/bookRoutes.js
const bookController = require("../controllers/bookController");

module.exports = async function (fastify, opts) {
  
  // IMPORT (Excel)
  fastify.post("/import", bookController.importBooks);

  // EXPORT (Excel)
  fastify.get("/export", bookController.exportBooks);

  // CREATE
  fastify.post("/", bookController.createBook);

  // GET ALL
  fastify.get("/", bookController.getBooks);

  // GET SINGLE
  fastify.get("/:id", bookController.getBookById);

  // UPDATE
  fastify.put("/:id", bookController.updateBook);

  // DELETE
  fastify.delete("/:id", bookController.deleteBook);
};
