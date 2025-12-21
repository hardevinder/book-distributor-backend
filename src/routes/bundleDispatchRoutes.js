"use strict";

const bundleDispatchController = require("../controllers/bundleDispatchController");

module.exports = async function (fastify) {
  // ------------------------------------------------------
  // Create dispatch
  // POST /api/bundle-dispatches
  // ------------------------------------------------------
  fastify.post(
    "/",
    { preHandler: [fastify.authenticate] },
    bundleDispatchController.createDispatch
  );

  // ------------------------------------------------------
  // List dispatches (filters: bundle_id, status, q, etc.)
  // GET /api/bundle-dispatches
  // ------------------------------------------------------
  fastify.get(
    "/",
    { preHandler: [fastify.authenticate] },
    bundleDispatchController.listDispatches
  );

  // ------------------------------------------------------
  // Download Delivery Challan (PDF)
  // IMPORTANT: static route BEFORE :id
  // GET /api/bundle-dispatches/:id/challan
  // ------------------------------------------------------
  fastify.get(
    "/:id/challan",
    { preHandler: [fastify.authenticate] },
    bundleDispatchController.downloadChallanPdf
  );

  // ------------------------------------------------------
  // Update dispatch status / details
  // PATCH /api/bundle-dispatches/:id/status
  // ------------------------------------------------------
  fastify.patch(
    "/:id/status",
    { preHandler: [fastify.authenticate] },
    bundleDispatchController.updateStatus
  );
};
