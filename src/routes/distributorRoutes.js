"use strict";

const distributorController = require("../controllers/distributorController");

module.exports = async function (fastify) {
  // sanity: if controller not loaded, crash early with clear message
  if (!distributorController || typeof distributorController.list !== "function") {
    throw new Error("distributorController.list is missing. Check src/controllers/distributorController.js exports.");
  }

  // 🔹 List distributors
  fastify.get(
    "/",
    { preHandler: [fastify.authenticate] },
    distributorController.list
  );

  // 🔹 Create distributor only
  fastify.post(
    "/",
    { preHandler: [fastify.authenticate] },
    distributorController.create
  );

  // 🔹 Create distributor + user (LOGIN)  ✅ NEW
  fastify.post(
    "/with-user",
    { preHandler: [fastify.authenticate] },
    distributorController.createWithUser
  );

  // 🔹 Update distributor
  fastify.put(
    "/:id",
    { preHandler: [fastify.authenticate] },
    distributorController.update
  );

  // 🔹 Soft delete distributor
  fastify.delete(
    "/:id",
    { preHandler: [fastify.authenticate] },
    distributorController.remove
  );
};
