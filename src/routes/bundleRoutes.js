// src/routes/bundleRoutes.js
"use strict";

const bundleController = require("../controllers/bundleController");

module.exports = async function (fastify, opts) {
  // 🔐 Protect all bundle routes
  fastify.addHook("onRequest", fastify.authenticate);

  // ======================================================
  // ✅ STATIC ROUTES FIRST (avoid conflict with /:id)
  // ======================================================

  // GET /api/bundles
  // query: school_id, class_id, class_name, academic_session, is_active
  fastify.get("/", bundleController.listBundles);

  // POST /api/bundles
  fastify.post("/", bundleController.createBundle);

  // ======================================================
  // ✅ ITEM ROUTES BEFORE /:id (keep order safe)
  // ======================================================

  /**
   * POST /api/bundles/:id/items
   * Body:
   * {
   *   replace: false,
   *   items: [
   *     { id?, product_id, qty, mrp, sale_price, is_optional, sort_order }
   *   ]
   * }
   */
  fastify.post("/:id/items", bundleController.upsertBundleItems);

  // DELETE /api/bundles/:id/items/:itemId
  fastify.delete("/:id/items/:itemId", bundleController.deleteBundleItem);

  // ======================================================
  // ✅ PARAM ROUTES LAST
  // ======================================================

  // GET /api/bundles/:id
  fastify.get("/:id", bundleController.getBundleById);

  // PUT /api/bundles/:id
  fastify.put("/:id", bundleController.updateBundle);

  // DELETE /api/bundles/:id
  fastify.delete("/:id", bundleController.deleteBundle);
};
