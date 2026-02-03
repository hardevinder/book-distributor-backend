// src/routes/bundleRoutes.js
"use strict";

const bundleController = require("../controllers/bundleController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

module.exports = async function (fastify, opts) {
  // 🔐 JWT auth for all bundle routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔓 READ access
  const READ = { preHandler: [requireRoles("superadmin", "distributor")] };

  // 🔒 WRITE access
  const WRITE = { preHandler: [requireRoles(...SUPERADMIN_ONLY)] };

  // ======================================================
  // ✅ STATIC ROUTES FIRST (avoid conflict with /:id)
  // ======================================================

  // GET /api/bundles  (READ)
  fastify.get("/", READ, bundleController.listBundles);

  // POST /api/bundles  (WRITE)
  fastify.post("/", WRITE, bundleController.createBundle);

  // ======================================================
  // ✅ ITEM ROUTES BEFORE /:id
  // ======================================================

  // POST /api/bundles/:id/items  (WRITE)
  fastify.post("/:id/items", WRITE, bundleController.upsertBundleItems);

  // DELETE /api/bundles/:id/items/:itemId  (WRITE)
  fastify.delete("/:id/items/:itemId", WRITE, bundleController.deleteBundleItem);

  // ======================================================
  // ✅ PARAM ROUTES LAST
  // ======================================================

  // GET /api/bundles/:id  (READ)
  fastify.get("/:id", READ, bundleController.getBundleById);

  // PUT /api/bundles/:id  (WRITE)
  fastify.put("/:id", WRITE, bundleController.updateBundle);

  // DELETE /api/bundles/:id  (WRITE)
  fastify.delete("/:id", WRITE, bundleController.deleteBundle);
};
