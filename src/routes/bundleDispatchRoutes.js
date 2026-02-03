"use strict";

const bundleDispatchController = require("../controllers/bundleDispatchController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

module.exports = async function (fastify) {
  // 🔒 Superadmin-only guard (auth + role)
  const superadminOnly = {
    preHandler: [fastify.authenticate, requireRoles(...SUPERADMIN_ONLY)],
  };

  // ------------------------------------------------------
  // Create dispatch
  // POST /api/bundle-dispatches
  // ------------------------------------------------------
  fastify.post(
    "/",
    superadminOnly,
    bundleDispatchController.createDispatch
  );

  // ------------------------------------------------------
  // List dispatches
  // GET /api/bundle-dispatches
  // ------------------------------------------------------
  fastify.get(
    "/",
    superadminOnly,
    bundleDispatchController.listDispatches
  );

  // ------------------------------------------------------
  // Download Delivery Challan (PDF)
  // IMPORTANT: static route BEFORE :id
  // GET /api/bundle-dispatches/:id/challan
  // ------------------------------------------------------
  fastify.get(
    "/:id/challan",
    superadminOnly,
    bundleDispatchController.downloadChallanPdf
  );

  // ------------------------------------------------------
  // Update dispatch status / details
  // PATCH /api/bundle-dispatches/:id/status
  // ------------------------------------------------------
  fastify.patch(
    "/:id/status",
    superadminOnly,
    bundleDispatchController.updateStatus
  );
};
