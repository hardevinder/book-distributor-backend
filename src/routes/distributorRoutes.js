"use strict";

const distributorController = require("../controllers/distributorController");

module.exports = async function (fastify) {
  // sanity: if controller not loaded, crash early with clear message
  if (!distributorController || typeof distributorController.list !== "function") {
    throw new Error("distributorController.list is missing. Check src/controllers/distributorController.js exports.");
  }

  fastify.get("/", { preHandler: [fastify.authenticate] }, distributorController.list);
  fastify.post("/", { preHandler: [fastify.authenticate] }, distributorController.create);
  fastify.put("/:id", { preHandler: [fastify.authenticate] }, distributorController.update);
  fastify.delete("/:id", { preHandler: [fastify.authenticate] }, distributorController.remove);
};
