"use strict";

const bundleIssueController = require("../controllers/bundleIssueController");

module.exports = async function (fastify) {
  /**
   * ⚠️ ORDER MATTERS
   * Static routes BEFORE param routes
   */

  // ======================================================
  // ✅ Frontend wrapper
  // POST /api/bundle-issues
  // body: { bundle_id, issued_to_type, issued_to_id, qty, notes }
  // ======================================================
  fastify.post(
    "/",
    { preHandler: [fastify.authenticate] },
    bundleIssueController.create
  );

  // ======================================================
  // ✅ Issue bundle directly
  // POST /api/bundle-issues/bundles/:id/issue
  // ======================================================
  fastify.post(
    "/bundles/:id/issue",
    { preHandler: [fastify.authenticate] },
    bundleIssueController.issueBundle
  );

  // ======================================================
  // ✅ List issues for ONE bundle
  // GET /api/bundle-issues/bundles/:id/issues
  // ======================================================
  fastify.get(
    "/bundles/:id/issues",
    { preHandler: [fastify.authenticate] },
    bundleIssueController.listIssuesForBundle
  );

  // ======================================================
  // ✅ Invoice PDF for a specific issue
  // GET /api/bundle-issues/:id/invoice
  // (works for SCHOOL + DISTRIBUTOR; RBAC inside controller)
  // ======================================================
  fastify.get(
    "/:id/invoice",
    { preHandler: [fastify.authenticate] },
    bundleIssueController.invoicePdf
  );

  // ======================================================
  // ✅ List recent issues (history page)
  // GET /api/bundle-issues?academic_session=2026-27&status=ISSUED
  // RBAC handled inside controller
  // ======================================================
  fastify.get(
    "/",
    { preHandler: [fastify.authenticate] },
    bundleIssueController.list
  );

  // ======================================================
  // ✅ Cancel issue
  // POST /api/bundle-issues/:id/cancel
  // ======================================================
  fastify.post(
    "/:id/cancel",
    { preHandler: [fastify.authenticate] },
    bundleIssueController.cancel
  );

  /**
   * (Optional – future)
   * GET /api/bundle-issues/:id
   * Issue details API
   *
   * fastify.get(
   *   "/:id",
   *   { preHandler: [fastify.authenticate] },
   *   bundleIssueController.getOne
   * );
   */
};
