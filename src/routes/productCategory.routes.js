"use strict";

const productCategoryController = require("../controllers/productCategory.controller");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

module.exports = async function (fastify, opts) {
  // 🔐 JWT auth for all category routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔒 SUPERADMIN only
  fastify.addHook("preHandler", requireRoles(...SUPERADMIN_ONLY));

  // ======================================================
  // PRODUCT CATEGORIES
  // Base: /api/product-categories
  // ======================================================

  // GET /api/product-categories
  // supports:
  // ?active=true|false
  // ?q=search
  // ?include_counts=1
  fastify.get("/", productCategoryController.listCategories);

  // GET /api/product-categories/:id
  fastify.get("/:id", productCategoryController.getCategoryById);

  // POST /api/product-categories
  fastify.post("/", productCategoryController.createCategory);

  // PUT /api/product-categories/:id
  fastify.put("/:id", productCategoryController.updateCategory);

  // PATCH /api/product-categories/:id/toggle
  fastify.patch("/:id/toggle", productCategoryController.toggleCategory);

  // DELETE /api/product-categories/:id
  fastify.delete("/:id", productCategoryController.deleteCategory);
};
