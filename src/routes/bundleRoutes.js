// src/routes/bundleRoutes.js
"use strict";

const {
  createBundle,
  listBundles,
  cancelBundle,
} = require("../controllers/bundleController");

module.exports = async function (fastify) {
  // ✅ protect with auth if you want
  // const auth = { preHandler: [fastify.authenticate] };

  // POST /api/bundles
  fastify.post("/", /* auth, */ createBundle);

  // GET /api/bundles?schoolId=&academic_session=&status=
  fastify.get("/", /* auth, */ listBundles);

  // POST /api/bundles/:id/cancel
  fastify.post("/:id/cancel", /* auth, */ cancelBundle);
};
