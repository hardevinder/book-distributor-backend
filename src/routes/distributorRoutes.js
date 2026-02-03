"use strict";

const distributorController = require("../controllers/distributorController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

module.exports = async function (fastify) {
  // Sanity check – fail fast if controller is broken
  if (!distributorController || typeof distributorController.list !== "function") {
    throw new Error(
      "distributorController.list is missing. Check src/controllers/distributorController.js exports."
    );
  }

  // 🔐 JWT auth for all distributor routes
  fastify.addHook("onRequest", fastify.authenticate);

  // 🔒 SUPERADMIN only
  fastify.addHook("preHandler", requireRoles(...SUPERADMIN_ONLY));

  /* =========================================================
   * DISTRIBUTORS
   * Base path: /api/distributors
   * ========================================================= */

  // 🔹 List distributors
  fastify.get("/", distributorController.list);

  // 🔹 Create distributor only
  fastify.post("/", distributorController.create);

  // 🔹 Create distributor + login user
  // POST /api/distributors/with-user
  fastify.post("/with-user", distributorController.createWithUser);

  /* =========================================================
   * DISTRIBUTOR LOGIN (USER)
   * ========================================================= */

  // 🔹 Get distributor login user (for edit screen)
  // GET /api/distributors/:id/user
  fastify.get("/:id/user", distributorController.getUserForDistributor);

  // 🔹 Update distributor login user (name / email / password)
  // PATCH /api/distributors/:id/user
  fastify.patch("/:id/user", distributorController.updateUserForDistributor);

  /* =========================================================
   * DISTRIBUTOR UPDATE / REMOVE
   * ========================================================= */

  // 🔹 Update distributor (details only)
  fastify.put("/:id", distributorController.update);

  // 🔹 Soft delete (deactivate) distributor
  fastify.delete("/:id", distributorController.remove);
};
