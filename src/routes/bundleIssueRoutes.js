"use strict";

const bundleIssueController = require("../controllers/bundleIssueController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

module.exports = async function (fastify) {
  /**
   * ⚠️ ORDER MATTERS
   * Static routes BEFORE param routes
   */

  // 🔒 Superadmin-only (very limited use)
  const superadminOnly = {
    preHandler: [fastify.authenticate, requireRoles(...SUPERADMIN_ONLY)],
  };

  // 🔓 Admin + Distributor (controller enforces ownership)
  const adminOrDistributor = {
    preHandler: [
      fastify.authenticate,
      requireRoles(
        "SUPERADMIN",
        "ADMIN",
        "OWNER",
        "STAFF",
        "ACCOUNTANT",
        "DISTRIBUTOR"
      ),
    ],
  };

  // ======================================================
  // Create bundle issue (wrapper)
  // POST /api/bundle-issues
  // ======================================================
  fastify.post(
    "/",
    adminOrDistributor,
    bundleIssueController.create
  );

  // ======================================================
  // Issue bundle directly
  // POST /api/bundle-issues/bundles/:id/issue
  // ======================================================
  fastify.post(
    "/bundles/:id/issue",
    adminOrDistributor,
    bundleIssueController.issueBundle
  );

  // ======================================================
  // List issues for ONE bundle
  // GET /api/bundle-issues/bundles/:id/issues
  // ======================================================
  fastify.get(
    "/bundles/:id/issues",
    adminOrDistributor,
    bundleIssueController.listIssuesForBundle
  );

  // ======================================================
  // Invoice PDF
  // GET /api/bundle-issues/:id/invoice
  // ======================================================
  fastify.get(
    "/:id/invoice",
    adminOrDistributor,
    bundleIssueController.invoicePdf
  );

  // ======================================================
  // List recent issues
  // GET /api/bundle-issues
  // ======================================================
  fastify.get(
    "/",
    adminOrDistributor,
    bundleIssueController.list
  );

  // ======================================================
  // Cancel issue
  // POST /api/bundle-issues/:id/cancel
  // ======================================================
  fastify.post(
    "/:id/cancel",
    adminOrDistributor,
    bundleIssueController.cancel
  );

  // ======================================================
  // Return issue (stock return)
  // POST /api/bundle-issues/:id/return
  // ======================================================
  fastify.post(
    "/:id/return",
    adminOrDistributor,
    bundleIssueController.returnIssue
  );
};
