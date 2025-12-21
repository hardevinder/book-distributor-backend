"use strict";

const bundleIssueController = require("../controllers/bundleIssueController");

module.exports = async function (fastify) {
  // ✅ Frontend wrapper: POST /api/bundle-issues
  fastify.post(
    "/",
    { preHandler: [fastify.authenticate] },
    bundleIssueController.create
  );

  // ✅ Issue bundle
  fastify.post(
    "/bundles/:id/issue",
    { preHandler: [fastify.authenticate] },
    bundleIssueController.issueBundle
  );

  // ✅ List issues for a single bundle
  fastify.get(
    "/bundles/:id/issues",
    { preHandler: [fastify.authenticate] },
    bundleIssueController.listIssuesForBundle
  );

  // ✅ List recent issues (supports ?academic_session=2026-27&status=ISSUED)
  fastify.get(
    "/",
    { preHandler: [fastify.authenticate] },
    bundleIssueController.list
  );

  // ✅ Cancel an issue (revert stock + update bundle items)
  fastify.post(
    "/:id/cancel",
    { preHandler: [fastify.authenticate] },
    bundleIssueController.cancel
  );

  // (Optional) If you want "Details" API separately:
  // fastify.get(
  //   "/:id",
  //   { preHandler: [fastify.authenticate] },
  //   bundleIssueController.getOne
  // );
};
