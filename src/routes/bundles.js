const bundleIssueController = require("../controllers/bundleIssueController");

fastify.post("/bundles/:id/issue", { preHandler: [fastify.authenticate] }, bundleIssueController.issueBundle);
fastify.get("/bundles/:id/issues", { preHandler: [fastify.authenticate] }, bundleIssueController.listIssuesForBundle);
