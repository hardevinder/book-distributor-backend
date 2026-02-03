// src/routes/bookRoutes.js
"use strict";

const bookController = require("../controllers/bookController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

module.exports = async function (fastify, opts) {
  const superadminOnly = { preHandler: [fastify.authenticate, requireRoles(...SUPERADMIN_ONLY)] };

  // IMPORT (Excel)
  fastify.post("/import", superadminOnly, bookController.importBooks);

  // EXPORT (Excel)
  fastify.get("/export", superadminOnly, bookController.exportBooks);

  // CREATE
  fastify.post("/", superadminOnly, bookController.createBook);

  // GET ALL
  fastify.get("/", superadminOnly, bookController.getBooks);

  // GET SINGLE
  fastify.get("/:id", superadminOnly, bookController.getBookById);

  // UPDATE
  fastify.put("/:id", superadminOnly, bookController.updateBook);

  // DELETE
  fastify.delete("/:id", superadminOnly, bookController.deleteBook);
};
