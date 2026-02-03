"use strict";

const bundleIssueController = require("../controllers/bundleIssueController");
const requireRoles = require("../middlewares/requireRoles");
const { SUPERADMIN_ONLY } = require("../constants/roles");

module.exports = async function (fastify) {
  /**
   * ⚠️ ORDER MATTERS
   * Static routes BEFORE param routes
   */

  // 🔒 Superadmin-only guard
  const superadminOnly = {
    preHandler: [fastify.authenticate, requireRoles(...SUPERADMIN_ONLY)],
  };

  // ======================================================
  // Create bundle issue (frontend wrapper)
  // POST /api/bundle-issues
  // ======================================================
  fastify.post(
    "/",
    superadminOnly,
    bundleIssueController.create
  );

  // ======================================================
  // Issue bundle directly
  // POST /api/bundle-issues/bundles/:id/issue
  // ======================================================
  fastify.post(
    "/bundles/:id/issue",
    superadminOnly,
    bundleIssueController.issueBundle
  );

  // ======================================================
  // List issues for ONE bundle
  // GET /api/bundle-issues/bundles/:id/issues
  // ======================================================
  fastify.get(
    "/bundles/:id/issues",
    superadminOnly,
    bundleIssueController.listIssuesForBundle
  );

  // ======================================================
  // Invoice PDF for a specific issue
  // GET /api/bundle-issues/:id/invoice
  // ======================================================
  fastify.get(
    "/:id/invoice",
    superadminOnly,
    bundleIssueController.invoicePdf
  );

  // ======================================================
  // List recent issues (history page)
  // GET /api/bundle-issues
  // ======================================================
  fastify.get(
    "/",
    superadminOnly,
    bundleIssueController.list
  );

  // ======================================================
  // Cancel issue
  // POST /api/bundle-issues/:id/cancel
  // ======================================================
  fastify.post(
    "/:id/cancel",
    superadminOnly,
    bundleIssueController.cancel
  );

  /**
   * (Optional – future)
   * GET /api/bundle-issues/:id
   */
  // fastify.get("/:id", superadminOnly, bundleIssueController.getOne);
};
